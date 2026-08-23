'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { readCatalog } = require('./simulator-capture');
const { readRecipes } = require('./simulator-record');
const { buildCoverageReport } = require('./simulator-coverage');
const {
  EXPECTED_GATES,
  evaluateReleaseGates,
  main,
  readDefinition,
  validateEvidence,
} = require('./release-gate');

const PROVIDER_COMMIT = 'a'.repeat(40);
const CONSUMER_COMMIT = 'b'.repeat(40);

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    values: () => ({ stdout, stderr }),
  };
}

function coverageReport() {
  const catalog = readCatalog();
  return buildCoverageReport(catalog, readRecipes(catalog));
}

function repository(version = '0.2.1', overrides = {}) {
  return {
    packageVersion: version,
    packageLockVersion: version,
    packageLockRootVersion: version,
    commit: PROVIDER_COMMIT,
    clean: true,
    ...overrides,
  };
}

function passedEvidence(overrides = {}) {
  const evidence = {
    schemaVersion: 1,
    targetVersion: '0.2.1',
    providerCommit: PROVIDER_COMMIT,
    gates: {
      providerPreflight: {
        status: 'passed',
        evidenceRef: 'provider-preflight-on-final-commit',
      },
      p0RootNavigationRegression: {
        status: 'passed',
        evidenceRef: 'p0-root-navigation-regression-on-final-commit',
      },
      crossRepoConvergence: {
        status: 'passed',
        evidenceRef: 'cross-repo-final-commit-run',
        consumerCommit: CONSUMER_COMMIT,
        contractVersion: 1,
        compatibilityTest: 'passed',
        providerFreeRegression: 'passed',
      },
    },
  };
  return {
    ...evidence,
    ...overrides,
    gates: {
      ...evidence.gates,
      ...(overrides.gates || {}),
    },
  };
}

test('reviewed v0.2.1 definition has only P0, release identity, and convergence gates', () => {
  const definition = readDefinition();
  assert.equal(definition.targetVersion, '0.2.1');
  assert.equal(definition.releasedBaseline, '0.2.0');
  assert.equal(definition.versionBoundary.baselineIncludesTargetScope, false);
  assert.deepEqual(definition.gates.map(({ id, kind, evidenceKey }) => ({
    id,
    kind,
    ...(evidenceKey ? { evidenceKey } : {}),
  })), EXPECTED_GATES);
});

test('current 0.2.0 source stays blocked without target evidence', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.0'),
    coverageReport: coverageReport(),
  });

  assert.equal(result.releaseStatus, 'blocked');
  assert.equal(result.activationAllowed, false);
  assert.deepEqual(
    result.gates.filter((gate) => gate.status === 'pass').map((gate) => gate.id),
    ['source-coverage-truth', 'release-commit-clean'],
  );
  assert.deepEqual(result.blockers.map((blocker) => blocker.gateId), [
    'target-version-identity',
    'provider-preflight',
    'p0-root-navigation-regression',
    'cross-repo-convergence',
  ]);
});

test('activation passes only when every gate targets the exact final provider commit', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: passedEvidence(),
  });

  assert.equal(result.releaseStatus, 'pass');
  assert.equal(result.activationAllowed, true);
  assert.deepEqual(result.blockers, []);
  assert.equal(result.gates.every((gate) => gate.status === 'pass'), true);
});

test('target version identity includes both package-lock version locations', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.1', { packageLockRootVersion: '0.2.0' }),
    coverageReport: coverageReport(),
    evidence: passedEvidence(),
  });

  assert.deepEqual(result.blockers, [{
    gateId: 'target-version-identity',
    reason: 'package_version_does_not_match_target',
  }]);
});

test('stale provider evidence and incomplete cross-repo convergence remain blockers', () => {
  const stale = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.1', { commit: 'c'.repeat(40) }),
    coverageReport: coverageReport(),
    evidence: passedEvidence(),
  });
  assert.equal(
    stale.gates.find((gate) => gate.id === 'p0-root-navigation-regression').reason,
    'evidence_provider_commit_mismatch',
  );

  const incomplete = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: passedEvidence({
      gates: {
        crossRepoConvergence: {
          status: 'passed',
          evidenceRef: 'cross-repo-final-commit-run',
          consumerCommit: CONSUMER_COMMIT,
          contractVersion: 1,
          compatibilityTest: 'passed',
          providerFreeRegression: 'failed',
        },
      },
    }),
  });
  assert.equal(incomplete.releaseStatus, 'blocked');
  assert.deepEqual(incomplete.blockers, [{
    gateId: 'cross-repo-convergence',
    reason: 'provider_free_regression_failed',
  }]);
});

test('release evidence is closed and provider-local CLI returns pass or blocked JSON', async () => {
  assert.throws(
    () => validateEvidence({ ...passedEvidence(), extra: true }),
    /unsupported field/,
  );

  const passedOutput = streams();
  assert.equal(await main(['check', '--target', '0.2.1', '--json'], passedOutput, {
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: passedEvidence(),
  }), 0);
  assert.equal(passedOutput.values().stderr, '');
  assert.equal(JSON.parse(passedOutput.values().stdout).releaseStatus, 'pass');

  const blockedOutput = streams();
  assert.equal(await main(['check', '--target', '0.2.1', '--json'], blockedOutput, {
    definition: readDefinition(),
    repository: repository('0.2.0'),
    coverageReport: coverageReport(),
    evidence: null,
  }), 3);
  assert.equal(blockedOutput.values().stderr, '');
  assert.equal(JSON.parse(blockedOutput.values().stdout).releaseStatus, 'blocked');
});
