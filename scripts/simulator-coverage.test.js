'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readCatalog } = require('./simulator-capture');
const { readRecipes } = require('./simulator-record');
const { buildCoverageReport, main } = require('./simulator-coverage');

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    values: () => ({ stdout, stderr }),
  };
}

function currentReport() {
  const catalog = readCatalog();
  return buildCoverageReport(catalog, readRecipes(catalog));
}

test('source coverage truth keeps readiness text, content, recipes, and runtime claims separate', () => {
  const report = currentReport();

  assert.equal(report.reportType, 'provider_source_coverage');
  assert.deepEqual(report.summary.catalogedRoutes, {
    numerator: 40,
    denominator: 40,
    ratio: 1,
  });
  assert.deepEqual(report.summary.navigationReadinessTextCandidates, {
    numerator: 40,
    denominator: 40,
    ratio: 1,
  });
  assert.deepEqual(report.summary.contentTextCandidates, {
    numerator: 3,
    denominator: 40,
    ratio: 0.075,
  });
  assert.deepEqual(report.summary.interactionRecipeRoutes, {
    numerator: 1,
    denominator: 40,
    ratio: 0.025,
    recipeCount: 2,
    reviewedCoordinateRecipeCount: 2,
  });
  assert.deepEqual(report.summary.explicitAccessibilityIdentifierCandidates, {
    numerator: 0,
    denominator: 40,
    ratio: 0,
  });
  assert.deepEqual(report.summary.runtimeVerifiedRoutes, {
    numerator: null,
    denominator: 40,
    ratio: null,
    status: 'not_claimed_by_source',
  });
});

test('missing explicit Accessibility identifiers do not claim Accessibility is unavailable', () => {
  const report = currentReport();
  const kline = report.routes.find((route) => route.routeId === 'chipk.stock.kline');
  const featured = report.routes.find(
    (route) => route.routeId === 'chipk.select.featured-main-force',
  );
  const stockMainForce = report.routes.find(
    (route) => route.routeId === 'chipk.stock.main-force',
  );

  assert.equal(kline.interactionRecipeCoverage.status, 'recipe_present');
  assert.deepEqual(kline.interactionRecipeCoverage.recipeIds, [
    'renbao.kline-main-force-swipe',
    'renbao.kline-tab-switch-benchmark',
  ]);
  assert.deepEqual(kline.interactionRecipeCoverage.selectorKinds, ['text']);
  assert.equal(
    kline.accessibilityIdentity.explicitIdentifierStatus,
    'not_declared_in_provider_source',
  );
  assert.equal(kline.accessibilityIdentity.runtimeAvailability, 'unknown_not_observed');
  assert.deepEqual(featured.contentTextCandidate.contentTexts, ['主力買賣超']);
  assert.deepEqual(stockMainForce.contentTextCandidate.contentTexts, ['買賣家數差']);
  assert.equal(featured.navigationReadinessTextCandidate.uniqueRouteIdentity, false);
  assert.equal(featured.runtimeVerification.status, 'not_claimed_by_source');
  assert.equal(featured.runtimeVerification.verified, null);
});

test('an explicit id selector is only a static candidate until runtime observation exists', () => {
  const catalog = {
    schemaVersion: 1,
    catalogVersion: 'synthetic',
    routes: [{
      id: 'chipk.synthetic.one',
      expectedTexts: ['One'],
      contentTexts: [],
      requiredParams: [],
      optionalParams: [],
    }],
  };
  const recipeFile = {
    schemaVersion: 1,
    recipes: [{
      id: 'synthetic.one',
      routeId: 'chipk.synthetic.one',
      actions: [{
        type: 'readiness',
        selectors: [{ kind: 'id', value: 'screen.one' }],
      }],
    }],
  };
  const report = buildCoverageReport(catalog, recipeFile);
  const route = report.routes[0];

  assert.equal(route.accessibilityIdentity.explicitIdentifierStatus, 'candidate_present');
  assert.deepEqual(route.accessibilityIdentity.explicitIdentifierSelectors, ['screen.one']);
  assert.equal(route.accessibilityIdentity.runtimeAvailability, 'unknown_not_observed');
  assert.deepEqual(report.summary.runtimeVerifiedRoutes, {
    numerator: null,
    denominator: 1,
    ratio: null,
    status: 'not_claimed_by_source',
  });
});

test('provider-local coverage CLI emits JSON without adding a canonical consumer command', async () => {
  const catalog = readCatalog();
  const output = streams();
  assert.equal(await main(['report', '--json'], output, {
    catalog,
    recipeFile: readRecipes(catalog),
  }), 0);
  assert.equal(output.values().stderr, '');
  assert.equal(JSON.parse(output.values().stdout).reportType, 'provider_source_coverage');

  const invalid = streams();
  assert.equal(await main(['coverage', '--json'], invalid), 2);
  assert.equal(invalid.values().stdout, '');
  assert.equal(JSON.parse(invalid.values().stderr).error, 'coverage_report_failed');
});
