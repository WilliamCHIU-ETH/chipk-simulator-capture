#!/usr/bin/env node

'use strict';

const { readCatalog } = require('./simulator-capture');
const { readRecipes } = require('./simulator-record');

const SOURCE_PATHS = Object.freeze({
  catalog: 'config/simulator-capture.catalog.json',
  recipes: 'config/simulator-recording-recipes.json',
});

function unique(values) {
  return [...new Set(values)].sort();
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : Number((numerator / denominator).toFixed(4));
}

function selectorsForRecipe(recipe) {
  return recipe.actions.flatMap((action) => [
    ...(action.selectors || []),
    ...(action.absentSelectors || []),
  ]);
}

function routeCoverage(route, recipes, defaultExpectedTexts = []) {
  const expectedTexts = unique([
    ...defaultExpectedTexts,
    ...(route.expectedTexts || []),
  ]);
  const contentTexts = unique(route.contentTexts || []);
  const requiredParameters = unique(
    (route.requiredParams || []).map((parameter) => (
      typeof parameter === 'string' ? parameter : parameter.name
    )),
  );
  const optionalParameters = unique(
    (route.optionalParams || []).map((parameter) => (
      typeof parameter === 'string' ? parameter : parameter.name
    )),
  );
  const selectors = recipes.flatMap(selectorsForRecipe);
  const accessibilityIdentifiers = unique(
    selectors.filter((selector) => selector.kind === 'id').map((selector) => selector.value),
  );
  const selectorKinds = unique(selectors.map((selector) => selector.kind));
  const actionTypes = unique(recipes.flatMap((recipe) => recipe.actions.map((action) => action.type)));
  const coordinateRecipeIds = unique(
    recipes
      .filter((recipe) => recipe.actions.some(
        (action) => action.execution?.strategy === 'reviewed_coordinate',
      ))
      .map((recipe) => recipe.id),
  );

  return {
    routeId: route.id,
    cataloged: true,
    navigationReadinessTextCandidate: {
      status: expectedTexts.length > 0 ? 'candidate_present' : 'coverage_gap',
      expectedTexts,
      targetParameters: {
        required: requiredParameters,
        optional: optionalParameters,
      },
      evidenceKind: 'versioned_catalog_declaration',
      uniqueRouteIdentity: false,
    },
    contentTextCandidate: {
      status: contentTexts.length > 0 ? 'candidate_present' : 'not_declared',
      contentTexts,
      evidenceKind: 'versioned_catalog_declaration',
    },
    interactionRecipeCoverage: {
      status: recipes.length > 0 ? 'recipe_present' : 'not_recipe_covered',
      recipeIds: recipes.map((recipe) => recipe.id).sort(),
      actionTypes,
      selectorKinds,
      reviewedCoordinateRecipeIds: coordinateRecipeIds,
    },
    accessibilityIdentity: {
      explicitIdentifierStatus: accessibilityIdentifiers.length > 0
        ? 'candidate_present'
        : 'not_declared_in_provider_source',
      explicitIdentifierSelectors: accessibilityIdentifiers,
      runtimeAvailability: 'unknown_not_observed',
    },
    runtimeVerification: {
      status: 'not_claimed_by_source',
      verified: null,
    },
  };
}

function metric(numerator, denominator, extra = {}) {
  return {
    numerator,
    denominator,
    ratio: ratio(numerator, denominator),
    ...extra,
  };
}

function buildCoverageReport(catalog, recipeFile) {
  const recipesByRoute = new Map();
  for (const recipe of recipeFile.recipes || []) {
    const recipes = recipesByRoute.get(recipe.routeId) || [];
    recipes.push(recipe);
    recipesByRoute.set(recipe.routeId, recipes);
  }

  const routes = catalog.routes.map((route) => (
    routeCoverage(
      route,
      recipesByRoute.get(route.id) || [],
      catalog.product?.defaultExpectedTexts || [],
    )
  ));
  const routeCount = routes.length;
  const navigationReadinessTextCandidateCount = routes.filter(
    (route) => route.navigationReadinessTextCandidate.status === 'candidate_present',
  ).length;
  const contentTextCandidateCount = routes.filter(
    (route) => route.contentTextCandidate.status === 'candidate_present',
  ).length;
  const recipeCoveredRouteCount = routes.filter(
    (route) => route.interactionRecipeCoverage.status === 'recipe_present',
  ).length;
  const explicitIdentifierRouteCount = routes.filter(
    (route) => route.accessibilityIdentity.explicitIdentifierStatus === 'candidate_present',
  ).length;
  const reviewedCoordinateRecipeCount = (recipeFile.recipes || []).filter(
    (recipe) => recipe.actions.some(
      (action) => action.execution?.strategy === 'reviewed_coordinate',
    ),
  ).length;

  return {
    schemaVersion: 1,
    reportType: 'provider_source_coverage',
    sources: {
      catalog: {
        path: SOURCE_PATHS.catalog,
        schemaVersion: catalog.schemaVersion,
        catalogVersion: catalog.catalogVersion,
      },
      recipes: {
        path: SOURCE_PATHS.recipes,
        schemaVersion: recipeFile.schemaVersion,
      },
    },
    evidenceBoundary: {
      basis: 'versioned_source_only',
      navigationReadinessTextCandidateMeaning:
        'catalog_text_candidate_not_unique_route_identity_or_runtime_observation',
      accessibilityAvailability: 'unknown_from_source',
      runtimeVerification: 'not_claimed_by_source',
      editorialSuitability: 'not_claimed_by_source',
    },
    summary: {
      catalogedRoutes: metric(routeCount, routeCount),
      navigationReadinessTextCandidates: metric(
        navigationReadinessTextCandidateCount,
        routeCount,
      ),
      contentTextCandidates: metric(contentTextCandidateCount, routeCount),
      interactionRecipeRoutes: metric(recipeCoveredRouteCount, routeCount, {
        recipeCount: (recipeFile.recipes || []).length,
        reviewedCoordinateRecipeCount,
      }),
      explicitAccessibilityIdentifierCandidates: metric(explicitIdentifierRouteCount, routeCount),
      runtimeVerifiedRoutes: {
        numerator: null,
        denominator: routeCount,
        ratio: null,
        status: 'not_claimed_by_source',
      },
    },
    routes,
  };
}

function usage() {
  return 'Usage: node scripts/simulator-coverage.js report --json';
}

async function main(
  argv = process.argv.slice(2),
  streams = { stdout: process.stdout, stderr: process.stderr },
  options = {},
) {
  try {
    if (argv.length !== 2 || argv[0] !== 'report' || argv[1] !== '--json') {
      throw new Error('command must be report --json');
    }
    const catalog = options.catalog || readCatalog();
    const recipeFile = options.recipeFile || readRecipes(catalog);
    const report = buildCoverageReport(catalog, recipeFile);
    streams.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  } catch (error) {
    streams.stderr.write(`${JSON.stringify({
      ok: false,
      error: 'coverage_report_failed',
      message: error.message,
      usage: usage(),
    }, null, 2)}\n`);
    return 2;
  }
}

if (require.main === module) {
  main().then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  SOURCE_PATHS,
  buildCoverageReport,
  main,
  routeCoverage,
  usage,
};
