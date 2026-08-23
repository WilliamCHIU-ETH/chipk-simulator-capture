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

function completeEvidence(overrides = {}) {
  const evidence = {
    schemaVersion: 1,
    targetVersion: '0.2.1',
    providerCommit: PROVIDER_COMMIT,
    attestations: {
      providerPreflight: {
        claimedStatus: 'passed',
        evidenceRef: 'provider-preflight-on-final-commit',
      },
      p0RootNavigationRegression: {
        claimedStatus: 'passed',
        evidenceRef: 'p0-root-navigation-regression-on-final-commit',
      },
      crossRepoConvergence: {
        claimedStatus: 'passed',
        evidenceRef: 'cross-repo-final-commit-run',
        consumerCommit: CONSUMER_COMMIT,
        contractVersion: 1,
        compatibilityTestClaim: 'passed',
        providerFreeRegressionClaim: 'passed',
      },
    },
  };
  return {
    ...evidence,
    ...overrides,
    attestations: {
      ...evidence.attestations,
      ...(overrides.attestations || {}),
    },
  };
}

function withoutCoverageField(pathParts) {
  const report = structuredClone(coverageReport());
  let parent = report;
  for (const part of pathParts.slice(0, -1)) parent = parent[part];
  delete parent[pathParts.at(-1)];
  return report;
}

test('reviewed v0.2.1 definition has only P0, release identity, and convergence gates', () => {
  const definition = readDefinition();
  assert.equal(definition.targetVersion, '0.2.1');
  assert.equal(definition.releasedBaseline, '0.2.0');
  assert.equal(definition.versionBoundary.baselineIncludesTargetScope, false);
  assert.deepEqual(definition.gates.map(({ id, kind, attestationKey }) => ({
    id,
    kind,
    ...(attestationKey ? { attestationKey } : {}),
  })), EXPECTED_GATES);
});

test('current 0.2.0 source has an incomplete release-review checklist', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.0'),
    coverageReport: coverageReport(),
  });

  assert.equal(result.checklistStatus, 'incomplete');
  assert.equal(result.automatedChecksComplete, false);
  assert.equal(result.attestationsComplete, false);
  assert.equal(result.readyForReleaseReview, false);
  assert.equal(result.releaseDecision, 'human_required');
  assert.equal(Object.hasOwn(result, 'activationAllowed'), false);
  assert.equal(Object.hasOwn(result, 'releaseStatus'), false);
  assert.deepEqual(
    result.gates.filter((gate) => gate.status === 'verified').map((gate) => gate.id),
    ['source-coverage-truth', 'release-commit-clean'],
  );
  assert.deepEqual(result.blockers.map((blocker) => blocker.gateId), [
    'target-version-identity',
    'provider-preflight',
    'p0-root-navigation-regression',
    'cross-repo-convergence',
  ]);
});

test('complete claims only make the checklist ready for human release review', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: completeEvidence(),
  });

  assert.equal(result.checklistStatus, 'ready_for_release_review');
  assert.equal(result.automatedChecksComplete, true);
  assert.equal(result.attestationsComplete, true);
  assert.equal(result.readyForReleaseReview, true);
  assert.equal(result.releaseDecision, 'human_required');
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(result.gates.map((gate) => gate.status), [
    'verified',
    'verified',
    'verified',
    'attested',
    'attested',
    'attested',
  ]);
  assert.deepEqual(result.attestationBoundary, {
    exactProviderCommitStringMatched: true,
    consumerCommitVerifiedByTool: false,
    attesterIdentityVerifiedByTool: false,
    evidenceRefsAuthenticatedByTool: false,
    commandsExecutedByTool: false,
    releaseOwnerReviewRequired: true,
  });
  assert.equal(Object.hasOwn(result, 'activationAllowed'), false);
  assert.equal(Object.hasOwn(result, 'tagAllowed'), false);
});

test('target version identity includes both package-lock version locations', () => {
  const result = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.1', { packageLockRootVersion: '0.2.0' }),
    coverageReport: coverageReport(),
    evidence: completeEvidence(),
  });

  assert.deepEqual(result.blockers, [{
    gateId: 'target-version-identity',
    reason: 'package_version_does_not_match_target',
  }]);
});

test('coverage gate blocks when any promised content, recipe, or Accessibility field is absent', () => {
  const requiredPaths = [
    ['summary', 'contentTextCandidates'],
    ['summary', 'contentTextCandidates', 'numerator'],
    ['summary', 'contentTextCandidates', 'denominator'],
    ['summary', 'contentTextCandidates', 'ratio'],
    ['summary', 'interactionRecipeRoutes'],
    ['summary', 'interactionRecipeRoutes', 'numerator'],
    ['summary', 'interactionRecipeRoutes', 'denominator'],
    ['summary', 'interactionRecipeRoutes', 'ratio'],
    ['summary', 'interactionRecipeRoutes', 'recipeCount'],
    ['summary', 'interactionRecipeRoutes', 'reviewedCoordinateRecipeCount'],
    ['summary', 'explicitAccessibilityIdentifierCandidates'],
    ['summary', 'explicitAccessibilityIdentifierCandidates', 'numerator'],
    ['summary', 'explicitAccessibilityIdentifierCandidates', 'denominator'],
    ['summary', 'explicitAccessibilityIdentifierCandidates', 'ratio'],
    ['routes', 0, 'contentTextCandidate'],
    ['routes', 0, 'contentTextCandidate', 'status'],
    ['routes', 0, 'contentTextCandidate', 'contentTexts'],
    ['routes', 0, 'contentTextCandidate', 'evidenceKind'],
    ['routes', 0, 'interactionRecipeCoverage'],
    ['routes', 0, 'interactionRecipeCoverage', 'status'],
    ['routes', 0, 'interactionRecipeCoverage', 'recipeIds'],
    ['routes', 0, 'interactionRecipeCoverage', 'actionTypes'],
    ['routes', 0, 'interactionRecipeCoverage', 'selectorKinds'],
    ['routes', 0, 'interactionRecipeCoverage', 'reviewedCoordinateRecipeIds'],
    ['routes', 0, 'accessibilityIdentity'],
    ['routes', 0, 'accessibilityIdentity', 'explicitIdentifierStatus'],
    ['routes', 0, 'accessibilityIdentity', 'explicitIdentifierSelectors'],
    ['routes', 0, 'accessibilityIdentity', 'runtimeAvailability'],
  ];

  for (const pathParts of requiredPaths) {
    const result = evaluateReleaseGates({
      definition: readDefinition(),
      repository: repository(),
      coverageReport: withoutCoverageField(pathParts),
      evidence: completeEvidence(),
    });
    assert.deepEqual(
      result.gates.find((gate) => gate.id === 'source-coverage-truth'),
      {
        id: 'source-coverage-truth',
        kind: 'automatic',
        status: 'blocked',
        reason: 'source_coverage_boundary_invalid',
      },
      pathParts.join('.'),
    );
    assert.equal(result.readyForReleaseReview, false, pathParts.join('.'));
  }
});

test('stale provider attestations and incomplete cross-repo claims remain blockers', () => {
  const stale = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository('0.2.1', { commit: 'c'.repeat(40) }),
    coverageReport: coverageReport(),
    evidence: completeEvidence(),
  });
  assert.equal(
    stale.gates.find((gate) => gate.id === 'p0-root-navigation-regression').reason,
    'attestation_provider_commit_mismatch',
  );

  const incomplete = evaluateReleaseGates({
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: completeEvidence({
      attestations: {
        crossRepoConvergence: {
          claimedStatus: 'passed',
          evidenceRef: 'cross-repo-final-commit-run',
          consumerCommit: CONSUMER_COMMIT,
          contractVersion: 1,
          compatibilityTestClaim: 'passed',
          providerFreeRegressionClaim: 'failed',
        },
      },
    }),
  });
  assert.equal(incomplete.checklistStatus, 'incomplete');
  assert.deepEqual(incomplete.blockers, [{
    gateId: 'cross-repo-convergence',
    reason: 'provider_free_regression_claim_failed',
  }]);
});

test('release attestation envelope is closed and CLI reports review readiness only', async () => {
  assert.throws(
    () => validateEvidence({ ...completeEvidence(), extra: true }),
    /unsupported field/,
  );

  const passedOutput = streams();
  assert.equal(await main(['check', '--target', '0.2.1', '--json'], passedOutput, {
    definition: readDefinition(),
    repository: repository(),
    coverageReport: coverageReport(),
    evidence: completeEvidence(),
  }), 0);
  assert.equal(passedOutput.values().stderr, '');
  assert.equal(passedOutput.values().stdout.includes('provider-preflight-on-final-commit'), false);
  const ready = JSON.parse(passedOutput.values().stdout);
  assert.equal(ready.readyForReleaseReview, true);
  assert.equal(ready.releaseDecision, 'human_required');

  const blockedOutput = streams();
  assert.equal(await main(['check', '--target', '0.2.1', '--json'], blockedOutput, {
    definition: readDefinition(),
    repository: repository('0.2.0'),
    coverageReport: coverageReport(),
    evidence: null,
  }), 3);
  assert.equal(blockedOutput.values().stderr, '');
  assert.equal(JSON.parse(blockedOutput.values().stdout).checklistStatus, 'incomplete');
});
