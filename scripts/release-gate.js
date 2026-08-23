#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseJsonStrict } = require('../src/strict-json');
const { readCatalog } = require('./simulator-capture');
const { readRecipes } = require('./simulator-record');
const { buildCoverageReport } = require('./simulator-coverage');

const ROOT = path.resolve(__dirname, '..');
const DEFINITION_PATH = path.join(ROOT, 'config', 'release-gates.v0.2.1.json');
const MAX_EVIDENCE_BYTES = 64 * 1024;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const COMMIT_RE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const EXPECTED_GATES = Object.freeze([
  { id: 'source-coverage-truth', kind: 'automatic' },
  { id: 'target-version-identity', kind: 'automatic' },
  { id: 'release-commit-clean', kind: 'automatic' },
  { id: 'provider-preflight', kind: 'attestation', attestationKey: 'providerPreflight' },
  {
    id: 'p0-root-navigation-regression',
    kind: 'attestation',
    attestationKey: 'p0RootNavigationRegression',
  },
  {
    id: 'cross-repo-convergence',
    kind: 'cross_repository_attestation',
    attestationKey: 'crossRepoConvergence',
  },
]);

class ReleaseGateError extends Error {
  constructor(message, code = 'release_gate_invalid') {
    super(message);
    this.name = 'ReleaseGateError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(value, allowed, label) {
  if (!isRecord(value)) throw new ReleaseGateError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ReleaseGateError(`${label} contains unsupported field: ${key}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ReleaseGateError(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function readStrictJson(file, label, { absolute = false, maxBytes = MAX_EVIDENCE_BYTES } = {}) {
  if (absolute && !path.isAbsolute(file)) {
    throw new ReleaseGateError(`${label} path must be absolute`, 'release_evidence_invalid');
  }
  let metadata;
  try {
    metadata = fs.lstatSync(file);
  } catch {
    throw new ReleaseGateError(`${label} is unavailable`, 'release_evidence_invalid');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new ReleaseGateError(`${label} must be a bounded regular file`, 'release_evidence_invalid');
  }
  try {
    return parseJsonStrict(fs.readFileSync(file, 'utf8'), label, 'release_evidence_invalid');
  } catch (error) {
    throw new ReleaseGateError(error.message, error.code || 'release_evidence_invalid');
  }
}

function validateDefinition(definition) {
  requireKeys(
    definition,
    new Set([
      'schemaVersion',
      'targetVersion',
      'releasedBaseline',
      'completionPolicy',
      'gates',
      'versionBoundary',
    ]),
    'release gate definition',
  );
  if (definition.schemaVersion !== 1) throw new ReleaseGateError('definition schemaVersion must be 1');
  requireString(definition.targetVersion, 'definition.targetVersion');
  requireString(definition.releasedBaseline, 'definition.releasedBaseline');
  if (definition.completionPolicy !== 'all_required_checks_complete_before_release_review') {
    throw new ReleaseGateError('definition.completionPolicy is unsupported');
  }
  if (!Array.isArray(definition.gates) || definition.gates.length !== EXPECTED_GATES.length) {
    throw new ReleaseGateError('definition.gates must contain the complete required gate set');
  }
  definition.gates.forEach((gate, index) => {
    const expected = EXPECTED_GATES[index];
    requireKeys(
      gate,
      new Set(['id', 'kind', 'attestationKey', 'completionCondition']),
      `definition.gates[${index}]`,
    );
    if (gate.id !== expected.id || gate.kind !== expected.kind) {
      throw new ReleaseGateError(`definition gate order or identity changed at ${index}`);
    }
    if ((gate.attestationKey || undefined) !== expected.attestationKey) {
      throw new ReleaseGateError(`definition gate attestation key changed for ${gate.id}`);
    }
    requireString(gate.completionCondition, `definition gate ${gate.id}.completionCondition`);
  });
  requireKeys(
    definition.versionBoundary,
    new Set(['baselineIncludesTargetScope', 'rule']),
    'definition.versionBoundary',
  );
  if (definition.versionBoundary.baselineIncludesTargetScope !== false) {
    throw new ReleaseGateError('released baseline must not claim target scope');
  }
  requireString(definition.versionBoundary.rule, 'definition.versionBoundary.rule');
  return definition;
}

function validateEvidenceItem(value, label, { crossRepository = false } = {}) {
  requireKeys(
    value,
    new Set([
      'claimedStatus',
      'evidenceRef',
      ...(crossRepository
        ? [
          'consumerCommit',
          'contractVersion',
          'compatibilityTestClaim',
          'providerFreeRegressionClaim',
        ]
        : []),
    ]),
    label,
  );
  if (!['passed', 'failed', 'pending'].includes(value.claimedStatus)) {
    throw new ReleaseGateError(`${label}.claimedStatus is unsupported`, 'release_evidence_invalid');
  }
  requireString(value.evidenceRef, `${label}.evidenceRef`);
  if (crossRepository) {
    if (value.contractVersion !== 1) {
      throw new ReleaseGateError(`${label}.contractVersion must be 1`, 'release_evidence_invalid');
    }
    if (!COMMIT_RE.test(String(value.consumerCommit || ''))) {
      throw new ReleaseGateError(`${label}.consumerCommit is invalid`, 'release_evidence_invalid');
    }
    for (const field of ['compatibilityTestClaim', 'providerFreeRegressionClaim']) {
      if (!['passed', 'failed', 'pending'].includes(value[field])) {
        throw new ReleaseGateError(`${label}.${field} is unsupported`, 'release_evidence_invalid');
      }
    }
  }
  return value;
}

function validateEvidence(evidence) {
  requireKeys(
    evidence,
    new Set(['schemaVersion', 'targetVersion', 'providerCommit', 'attestations']),
    'release attestation envelope',
  );
  if (evidence.schemaVersion !== 1) {
    throw new ReleaseGateError(
      'release attestation envelope schemaVersion must be 1',
      'release_evidence_invalid',
    );
  }
  requireString(evidence.targetVersion, 'release attestation envelope.targetVersion');
  if (!COMMIT_RE.test(String(evidence.providerCommit || ''))) {
    throw new ReleaseGateError(
      'release attestation envelope.providerCommit is invalid',
      'release_evidence_invalid',
    );
  }
  requireKeys(
    evidence.attestations,
    new Set(EXPECTED_GATES.map((gate) => gate.attestationKey).filter(Boolean)),
    'release attestation envelope.attestations',
  );
  for (const gate of EXPECTED_GATES.filter((candidate) => candidate.attestationKey)) {
    const value = evidence.attestations[gate.attestationKey];
    if (value !== undefined) {
      validateEvidenceItem(value, `release attestation envelope.attestations.${gate.attestationKey}`, {
        crossRepository: gate.kind === 'cross_repository_attestation',
      });
    }
  }
  return evidence;
}

function readDefinition(file = DEFINITION_PATH) {
  return validateDefinition(readStrictJson(file, 'release gate definition', {
    maxBytes: MAX_EVIDENCE_BYTES,
  }));
}

function sanitizedGitEnvironment(environment = process.env) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !key.startsWith('GIT_')),
  );
}

function git(root, args, environment = process.env) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: sanitizedGitEnvironment(environment),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error || result.status !== 0) {
    throw new ReleaseGateError('repository identity is unavailable', 'repository_identity_unavailable');
  }
  return result.stdout.trim();
}

function inspectRepository(root = ROOT, environment = process.env) {
  const packageJson = readStrictJson(path.join(root, 'package.json'), 'package.json', {
    maxBytes: MAX_SOURCE_BYTES,
  });
  const packageLock = readStrictJson(path.join(root, 'package-lock.json'), 'package-lock.json', {
    maxBytes: MAX_SOURCE_BYTES,
  });
  const commit = git(root, ['rev-parse', '--verify', 'HEAD'], environment);
  if (!COMMIT_RE.test(commit)) {
    throw new ReleaseGateError('repository HEAD is invalid', 'repository_identity_unavailable');
  }
  const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all'], environment);
  return {
    packageVersion: requireString(packageJson.version, 'package.json.version'),
    packageLockVersion: requireString(packageLock.version, 'package-lock.json.version'),
    packageLockRootVersion: requireString(
      packageLock.packages?.['']?.version,
      'package-lock.json packages root version',
    ),
    commit,
    clean: status === '',
  };
}

function verified(gate, reason) {
  return { id: gate.id, kind: gate.kind, status: 'verified', reason };
}

function attested(gate, reason) {
  return { id: gate.id, kind: gate.kind, status: 'attested', reason };
}

function blocked(gate, reason) {
  return { id: gate.id, kind: gate.kind, status: 'blocked', reason };
}

function isStringArray(value) {
  return Array.isArray(value)
    && value.every((item) => typeof item === 'string' && item.length > 0);
}

function metricMatches(metric, numerator, denominator) {
  const expectedRatio = denominator === 0
    ? null
    : Number((numerator / denominator).toFixed(4));
  return isRecord(metric)
    && metric.numerator === numerator
    && metric.denominator === denominator
    && metric.ratio === expectedRatio;
}

function routeCoverageBoundaryPasses(route) {
  if (!isRecord(route) || typeof route.routeId !== 'string' || route.cataloged !== true) return false;
  const readiness = route.navigationReadinessTextCandidate;
  const content = route.contentTextCandidate;
  const interaction = route.interactionRecipeCoverage;
  const accessibility = route.accessibilityIdentity;
  const runtime = route.runtimeVerification;
  if (!isRecord(readiness)
    || !['candidate_present', 'coverage_gap'].includes(readiness.status)
    || !isStringArray(readiness.expectedTexts)
    || !isRecord(readiness.targetParameters)
    || !isStringArray(readiness.targetParameters.required)
    || !isStringArray(readiness.targetParameters.optional)
    || readiness.evidenceKind !== 'versioned_catalog_declaration'
    || readiness.uniqueRouteIdentity !== false
    || (readiness.status === 'candidate_present') !== (readiness.expectedTexts.length > 0)) {
    return false;
  }
  if (!isRecord(content)
    || !['candidate_present', 'not_declared'].includes(content.status)
    || !isStringArray(content.contentTexts)
    || content.evidenceKind !== 'versioned_catalog_declaration'
    || (content.status === 'candidate_present') !== (content.contentTexts.length > 0)) {
    return false;
  }
  if (!isRecord(interaction)
    || !['recipe_present', 'not_recipe_covered'].includes(interaction.status)
    || !isStringArray(interaction.recipeIds)
    || !isStringArray(interaction.actionTypes)
    || !isStringArray(interaction.selectorKinds)
    || !isStringArray(interaction.reviewedCoordinateRecipeIds)
    || (interaction.status === 'recipe_present') !== (interaction.recipeIds.length > 0)) {
    return false;
  }
  if (!isRecord(accessibility)
    || !['candidate_present', 'not_declared_in_provider_source']
      .includes(accessibility.explicitIdentifierStatus)
    || !isStringArray(accessibility.explicitIdentifierSelectors)
    || accessibility.runtimeAvailability !== 'unknown_not_observed'
    || (accessibility.explicitIdentifierStatus === 'candidate_present')
      !== (accessibility.explicitIdentifierSelectors.length > 0)) {
    return false;
  }
  return isRecord(runtime)
    && runtime.status === 'not_claimed_by_source'
    && runtime.verified === null;
}

function coverageBoundaryPasses(report) {
  if (report?.reportType !== 'provider_source_coverage'
    || report?.evidenceBoundary?.basis !== 'versioned_source_only'
    || report?.evidenceBoundary?.navigationReadinessTextCandidateMeaning
      !== 'catalog_text_candidate_not_unique_route_identity_or_runtime_observation'
    || report?.evidenceBoundary?.accessibilityAvailability !== 'unknown_from_source'
    || report?.evidenceBoundary?.runtimeVerification !== 'not_claimed_by_source'
    || report?.evidenceBoundary?.editorialSuitability !== 'not_claimed_by_source'
    || !Array.isArray(report?.routes)
    || report.routes.length === 0
    || !report.routes.every(routeCoverageBoundaryPasses)) {
    return false;
  }

  const routeCount = report.routes.length;
  const readinessCount = report.routes.filter(
    (route) => route.navigationReadinessTextCandidate.status === 'candidate_present',
  ).length;
  const contentCount = report.routes.filter(
    (route) => route.contentTextCandidate.status === 'candidate_present',
  ).length;
  const recipeRouteCount = report.routes.filter(
    (route) => route.interactionRecipeCoverage.status === 'recipe_present',
  ).length;
  const recipeCount = report.routes.reduce(
    (count, route) => count + route.interactionRecipeCoverage.recipeIds.length,
    0,
  );
  const reviewedCoordinateRecipeCount = report.routes.reduce(
    (count, route) => (
      count + route.interactionRecipeCoverage.reviewedCoordinateRecipeIds.length
    ),
    0,
  );
  const explicitIdentifierCount = report.routes.filter(
    (route) => route.accessibilityIdentity.explicitIdentifierStatus === 'candidate_present',
  ).length;
  const summary = report.summary;
  return isRecord(summary)
    && metricMatches(summary.catalogedRoutes, routeCount, routeCount)
    && metricMatches(summary.navigationReadinessTextCandidates, readinessCount, routeCount)
    && metricMatches(summary.contentTextCandidates, contentCount, routeCount)
    && metricMatches(summary.interactionRecipeRoutes, recipeRouteCount, routeCount)
    && summary.interactionRecipeRoutes.recipeCount === recipeCount
    && summary.interactionRecipeRoutes.reviewedCoordinateRecipeCount
      === reviewedCoordinateRecipeCount
    && metricMatches(
      summary.explicitAccessibilityIdentifierCandidates,
      explicitIdentifierCount,
      routeCount,
    )
    && isRecord(summary.runtimeVerifiedRoutes)
    && summary.runtimeVerifiedRoutes.numerator === null
    && summary.runtimeVerifiedRoutes.denominator === routeCount
    && summary.runtimeVerifiedRoutes.ratio === null
    && summary.runtimeVerifiedRoutes.status === 'not_claimed_by_source';
}

function attestationGateResult(gate, definition, repository, evidence) {
  if (!evidence) return blocked(gate, 'release_attestation_required');
  if (evidence.targetVersion !== definition.targetVersion) {
    return blocked(gate, 'attestation_target_version_mismatch');
  }
  if (evidence.providerCommit !== repository.commit) {
    return blocked(gate, 'attestation_provider_commit_mismatch');
  }
  const item = evidence.attestations[gate.attestationKey];
  if (!item) return blocked(gate, 'gate_attestation_required');
  if (item.claimedStatus !== 'passed') {
    return blocked(gate, `attestation_claim_${item.claimedStatus}`);
  }
  if (gate.kind === 'cross_repository_attestation') {
    if (item.compatibilityTestClaim !== 'passed') {
      return blocked(gate, `compatibility_test_claim_${item.compatibilityTestClaim}`);
    }
    if (item.providerFreeRegressionClaim !== 'passed') {
      return blocked(gate, `provider_free_regression_claim_${item.providerFreeRegressionClaim}`);
    }
  }
  return attested(
    gate,
    'claim_complete_for_matching_provider_commit_manual_evidence_review_required',
  );
}

function evaluateReleaseGates({ definition, repository, coverageReport, evidence = null }) {
  validateDefinition(definition);
  if (!isRecord(repository) || !COMMIT_RE.test(String(repository.commit || ''))) {
    throw new ReleaseGateError('repository input is invalid');
  }
  requireString(repository.packageVersion, 'repository.packageVersion');
  requireString(repository.packageLockVersion, 'repository.packageLockVersion');
  requireString(repository.packageLockRootVersion, 'repository.packageLockRootVersion');
  if (typeof repository.clean !== 'boolean') throw new ReleaseGateError('repository.clean must be boolean');
  if (evidence) validateEvidence(evidence);

  const gates = definition.gates.map((gate) => {
    if (gate.id === 'source-coverage-truth') {
      return coverageBoundaryPasses(coverageReport)
        ? verified(gate, 'source_categories_are_closed_and_runtime_is_unclaimed')
        : blocked(gate, 'source_coverage_boundary_invalid');
    }
    if (gate.id === 'target-version-identity') {
      return [
        repository.packageVersion,
        repository.packageLockVersion,
        repository.packageLockRootVersion,
      ].every((version) => version === definition.targetVersion)
        ? verified(gate, 'package_version_matches_target')
        : blocked(gate, 'package_version_does_not_match_target');
    }
    if (gate.id === 'release-commit-clean') {
      return repository.clean
        ? verified(gate, 'release_commit_is_exact_and_worktree_is_clean')
        : blocked(gate, 'provider_worktree_is_not_clean');
    }
    return attestationGateResult(gate, definition, repository, evidence);
  });
  const blockers = gates
    .filter((gate) => gate.status === 'blocked')
    .map((gate) => ({ gateId: gate.id, reason: gate.reason }));
  const automatedChecksComplete = gates
    .filter((gate) => gate.kind === 'automatic')
    .every((gate) => gate.status === 'verified');
  const attestationsComplete = gates
    .filter((gate) => gate.kind !== 'automatic')
    .every((gate) => gate.status === 'attested');
  const readyForReleaseReview = automatedChecksComplete && attestationsComplete;

  return {
    schemaVersion: 1,
    targetVersion: definition.targetVersion,
    releasedBaseline: definition.releasedBaseline,
    checklistStatus: readyForReleaseReview ? 'ready_for_release_review' : 'incomplete',
    automatedChecksComplete,
    attestationsComplete,
    readyForReleaseReview,
    releaseDecision: 'human_required',
    repository,
    sourceCoverage: coverageReport?.summary || null,
    gates,
    blockers,
    attestationBoundary: {
      exactProviderCommitStringMatched: Boolean(
        evidence && evidence.providerCommit === repository.commit,
      ),
      consumerCommitVerifiedByTool: false,
      attesterIdentityVerifiedByTool: false,
      evidenceRefsAuthenticatedByTool: false,
      commandsExecutedByTool: false,
      releaseOwnerReviewRequired: true,
    },
    versionBoundary: definition.versionBoundary,
  };
}

function parseArgs(argv) {
  if (argv[0] !== 'check') throw new ReleaseGateError('command must be check', 'invalid_cli');
  const values = {};
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--json') {
      if (values.json) throw new ReleaseGateError('--json cannot be repeated', 'invalid_cli');
      values.json = true;
      continue;
    }
    if (flag === '--target' || flag === '--evidence') {
      if (values[flag]) throw new ReleaseGateError(`${flag} cannot be repeated`, 'invalid_cli');
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new ReleaseGateError(`${flag} requires a value`, 'invalid_cli');
      }
      values[flag] = value;
      index += 1;
      continue;
    }
    throw new ReleaseGateError(`unsupported flag: ${flag}`, 'invalid_cli');
  }
  if (!values.json || !values['--target']) {
    throw new ReleaseGateError('--target and --json are required', 'invalid_cli');
  }
  return {
    target: values['--target'],
    evidencePath: values['--evidence'] || null,
  };
}

function usage() {
  return [
    'Usage:',
    '  node scripts/release-gate.js check --target 0.2.1 --json',
    '  node scripts/release-gate.js check --target 0.2.1 --evidence <absolute-json-file> --json',
  ].join('\n');
}

async function main(
  argv = process.argv.slice(2),
  streams = { stdout: process.stdout, stderr: process.stderr },
  options = {},
) {
  try {
    const args = parseArgs(argv);
    const definition = options.definition || readDefinition();
    if (args.target !== definition.targetVersion) {
      throw new ReleaseGateError('target does not match the reviewed definition', 'invalid_cli');
    }
    const repository = options.repository || inspectRepository();
    const catalog = options.catalog || readCatalog();
    const recipeFile = options.recipeFile || readRecipes(catalog);
    const coverageReport = options.coverageReport || buildCoverageReport(catalog, recipeFile);
    const evidence = options.evidence !== undefined
      ? options.evidence
      : args.evidencePath
        ? validateEvidence(readStrictJson(
          args.evidencePath,
          'release attestation envelope',
          { absolute: true },
        ))
        : null;
    const result = evaluateReleaseGates({
      definition,
      repository,
      coverageReport,
      evidence,
    });
    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.readyForReleaseReview ? 0 : 3;
  } catch (error) {
    streams.stderr.write(`${JSON.stringify({
      ok: false,
      error: error.code || 'release_gate_failed',
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
  COMMIT_RE,
  DEFINITION_PATH,
  EXPECTED_GATES,
  ReleaseGateError,
  evaluateReleaseGates,
  inspectRepository,
  main,
  parseArgs,
  readDefinition,
  validateDefinition,
  validateEvidence,
};
