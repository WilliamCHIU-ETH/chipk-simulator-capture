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
  { id: 'provider-preflight', kind: 'evidence', evidenceKey: 'providerPreflight' },
  {
    id: 'p0-root-navigation-regression',
    kind: 'evidence',
    evidenceKey: 'p0RootNavigationRegression',
  },
  {
    id: 'cross-repo-convergence',
    kind: 'cross_repository_evidence',
    evidenceKey: 'crossRepoConvergence',
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
      'activationPolicy',
      'gates',
      'versionBoundary',
    ]),
    'release gate definition',
  );
  if (definition.schemaVersion !== 1) throw new ReleaseGateError('definition schemaVersion must be 1');
  requireString(definition.targetVersion, 'definition.targetVersion');
  requireString(definition.releasedBaseline, 'definition.releasedBaseline');
  if (definition.activationPolicy !== 'all_required_gates_must_pass') {
    throw new ReleaseGateError('definition.activationPolicy is unsupported');
  }
  if (!Array.isArray(definition.gates) || definition.gates.length !== EXPECTED_GATES.length) {
    throw new ReleaseGateError('definition.gates must contain the complete required gate set');
  }
  definition.gates.forEach((gate, index) => {
    const expected = EXPECTED_GATES[index];
    requireKeys(gate, new Set(['id', 'kind', 'evidenceKey', 'passCondition']), `definition.gates[${index}]`);
    if (gate.id !== expected.id || gate.kind !== expected.kind) {
      throw new ReleaseGateError(`definition gate order or identity changed at ${index}`);
    }
    if ((gate.evidenceKey || undefined) !== expected.evidenceKey) {
      throw new ReleaseGateError(`definition gate evidence key changed for ${gate.id}`);
    }
    requireString(gate.passCondition, `definition gate ${gate.id}.passCondition`);
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
      'status',
      'evidenceRef',
      ...(crossRepository
        ? ['consumerCommit', 'contractVersion', 'compatibilityTest', 'providerFreeRegression']
        : []),
    ]),
    label,
  );
  if (!['passed', 'failed', 'pending'].includes(value.status)) {
    throw new ReleaseGateError(`${label}.status is unsupported`, 'release_evidence_invalid');
  }
  requireString(value.evidenceRef, `${label}.evidenceRef`);
  if (crossRepository) {
    if (value.contractVersion !== 1) {
      throw new ReleaseGateError(`${label}.contractVersion must be 1`, 'release_evidence_invalid');
    }
    if (!COMMIT_RE.test(String(value.consumerCommit || ''))) {
      throw new ReleaseGateError(`${label}.consumerCommit is invalid`, 'release_evidence_invalid');
    }
    for (const field of ['compatibilityTest', 'providerFreeRegression']) {
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
    new Set(['schemaVersion', 'targetVersion', 'providerCommit', 'gates']),
    'release evidence',
  );
  if (evidence.schemaVersion !== 1) {
    throw new ReleaseGateError('release evidence schemaVersion must be 1', 'release_evidence_invalid');
  }
  requireString(evidence.targetVersion, 'release evidence.targetVersion');
  if (!COMMIT_RE.test(String(evidence.providerCommit || ''))) {
    throw new ReleaseGateError('release evidence.providerCommit is invalid', 'release_evidence_invalid');
  }
  requireKeys(
    evidence.gates,
    new Set(EXPECTED_GATES.map((gate) => gate.evidenceKey).filter(Boolean)),
    'release evidence.gates',
  );
  for (const gate of EXPECTED_GATES.filter((candidate) => candidate.evidenceKey)) {
    const value = evidence.gates[gate.evidenceKey];
    if (value !== undefined) {
      validateEvidenceItem(value, `release evidence.gates.${gate.evidenceKey}`, {
        crossRepository: gate.kind === 'cross_repository_evidence',
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

function pass(gate, reason) {
  return { id: gate.id, kind: gate.kind, status: 'pass', reason };
}

function blocked(gate, reason) {
  return { id: gate.id, kind: gate.kind, status: 'blocked', reason };
}

function coverageBoundaryPasses(report) {
  return report?.reportType === 'provider_source_coverage'
    && report?.evidenceBoundary?.navigationReadinessTextCandidateMeaning
      === 'catalog_text_candidate_not_unique_route_identity_or_runtime_observation'
    && report?.evidenceBoundary?.runtimeVerification === 'not_claimed_by_source'
    && report?.summary?.runtimeVerifiedRoutes?.numerator === null
    && report?.summary?.runtimeVerifiedRoutes?.ratio === null
    && Array.isArray(report?.routes)
    && report.routes.every((route) => (
      route.cataloged === true
      && route.runtimeVerification?.status === 'not_claimed_by_source'
      && route.runtimeVerification?.verified === null
    ));
}

function evidenceGateResult(gate, definition, repository, evidence) {
  if (!evidence) return blocked(gate, 'release_evidence_required');
  if (evidence.targetVersion !== definition.targetVersion) {
    return blocked(gate, 'evidence_target_version_mismatch');
  }
  if (evidence.providerCommit !== repository.commit) {
    return blocked(gate, 'evidence_provider_commit_mismatch');
  }
  const item = evidence.gates[gate.evidenceKey];
  if (!item) return blocked(gate, 'gate_evidence_required');
  if (item.status !== 'passed') return blocked(gate, `gate_evidence_${item.status}`);
  if (gate.kind === 'cross_repository_evidence') {
    if (item.compatibilityTest !== 'passed') {
      return blocked(gate, `compatibility_test_${item.compatibilityTest}`);
    }
    if (item.providerFreeRegression !== 'passed') {
      return blocked(gate, `provider_free_regression_${item.providerFreeRegression}`);
    }
  }
  return pass(gate, 'evidence_passed_for_exact_provider_commit');
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
        ? pass(gate, 'source_categories_are_separate_and_runtime_is_unclaimed')
        : blocked(gate, 'source_coverage_boundary_invalid');
    }
    if (gate.id === 'target-version-identity') {
      return [
        repository.packageVersion,
        repository.packageLockVersion,
        repository.packageLockRootVersion,
      ].every((version) => version === definition.targetVersion)
        ? pass(gate, 'package_version_matches_target')
        : blocked(gate, 'package_version_does_not_match_target');
    }
    if (gate.id === 'release-commit-clean') {
      return repository.clean
        ? pass(gate, 'release_commit_is_exact_and_worktree_is_clean')
        : blocked(gate, 'provider_worktree_is_not_clean');
    }
    return evidenceGateResult(gate, definition, repository, evidence);
  });
  const blockers = gates
    .filter((gate) => gate.status === 'blocked')
    .map((gate) => ({ gateId: gate.id, reason: gate.reason }));
  const activationAllowed = blockers.length === 0;

  return {
    schemaVersion: 1,
    targetVersion: definition.targetVersion,
    releasedBaseline: definition.releasedBaseline,
    releaseStatus: activationAllowed ? 'pass' : 'blocked',
    activationAllowed,
    repository,
    sourceCoverage: coverageReport?.summary || null,
    gates,
    blockers,
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
        ? validateEvidence(readStrictJson(args.evidencePath, 'release evidence', { absolute: true }))
        : null;
    const result = evaluateReleaseGates({
      definition,
      repository,
      coverageReport,
      evidence,
    });
    streams.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result.activationAllowed ? 0 : 3;
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
