'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const requestSchema = require('../contracts/capture-request.schema.json');
const resultSchema = require('../contracts/capture-result.schema.json');
const requestSchemaV2 = require('../contracts/capture-request-v2.schema.json');
const resultSchemaV2 = require('../contracts/capture-result-v2.schema.json');
const presentationProfilesSchema = require('../contracts/presentation-profiles.schema.json');
const presentationProfiles = require('../config/presentation-profiles.json');
const personaSchema = require('../contracts/personas.schema.json');
const personaExample = require('../config/personas.example.json');
const {
  ARTIFACT_KINDS,
  ARTIFACT_ROLES,
  ARTIFACT_ROLES_V2,
  MIME_TYPES,
  MODES,
  OPERATIONS,
  OPERATIONS_V2,
  PRESENTATION_FIELDS_V2,
  READY_TO_PLACE_EVIDENCE_FIELDS,
  RELATIVE_PATH_PATTERN_SOURCE,
  REQUEST_FIELDS,
  REQUEST_FIELDS_V2,
  REQUEST_ID_PATTERN_SOURCE,
  ROUTE_ID_PATTERN_SOURCE,
  SHA256_PATTERN_SOURCE,
  TARGET_FIELDS,
  TARGET_FIELDS_V2,
  validateRequest,
  validateResult,
} = require('../src/contract');
const { validateProfilesFile } = require('../src/presentation-profiles');

function sorted(values) {
  return [...values].sort();
}

function completedResult(artifact) {
  return {
    contractVersion: 1,
    requestId: 'result-test-001',
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'completed',
    artifacts: [artifact],
    evidence: {},
    error: null,
  };
}

const hash = 'a'.repeat(64);
const readyToPlaceEvidence = Object.freeze({
  routeSelection: 'catalog_exact_match',
  navigation: 'expected_texts_verified',
  material: 'ready_to_place',
  catalogVersion: 'catalog-test-v2',
  presentationProfile: {
    id: 'chipk.stock-main-force-portrait.v1',
    version: 1,
    status: 'ready_to_place',
  },
  publication: 'atomic_directory_rename',
});

test('request schema stays aligned with the closed v1 runtime contract', () => {
  assert.equal(requestSchema.additionalProperties, false);
  assert.deepEqual(sorted(requestSchema.required), sorted(REQUEST_FIELDS));
  assert.deepEqual(sorted(Object.keys(requestSchema.properties)), sorted(REQUEST_FIELDS));
  assert.deepEqual(requestSchema.properties.operation.enum, [...OPERATIONS]);
  assert.deepEqual(requestSchema.properties.mode.enum, [...MODES]);
  assert.equal(requestSchema.properties.requestId.pattern, REQUEST_ID_PATTERN_SOURCE);
  assert.deepEqual(sorted(Object.keys(requestSchema.properties.target.properties)), sorted(TARGET_FIELDS));
  assert.equal(requestSchema.properties.target.properties.routeId.pattern, ROUTE_ID_PATTERN_SOURCE);
  assert.match(requestSchema.properties.outputDirectory.pattern, /^\^\//);
  assert.throws(() => validateRequest({
    contractVersion: 1,
    requestId: 'root-output-test',
    operation: 'screenshot',
    mode: 'test',
    target: { routeId: 'chipk.stock.health-check' },
    outputDirectory: '/',
  }), { code: 'INVALID_REQUEST' });
  assert.equal(new RegExp(requestSchema.properties.outputDirectory.pattern).test('/'), false);
});

test('result schema exposes the same closed artifact vocabulary', () => {
  const artifact = resultSchema.$defs.artifact;
  assert.equal(artifact.additionalProperties, false);
  assert.deepEqual(artifact.properties.role.enum, [...ARTIFACT_ROLES]);
  assert.deepEqual(artifact.properties.kind.enum, [...ARTIFACT_KINDS]);
  assert.deepEqual(artifact.properties.mimeType.enum, [...MIME_TYPES]);
  assert.equal(artifact.properties.sha256.pattern, SHA256_PATTERN_SOURCE);
  assert.equal(artifact.properties.relativePath.pattern, RELATIVE_PATH_PATTERN_SOURCE);
  const relativePathPattern = new RegExp(artifact.properties.relativePath.pattern);
  for (const invalidPath of ['.', './nested', 'nested/./file', '..', '../file', 'nested/../file', 'folder\\file']) {
    assert.equal(relativePathPattern.test(invalidPath), false, invalidPath);
  }
  assert.equal(relativePathPattern.test('nested/file.json'), true);
});

test('v2 schemas remain closed and separate from the unchanged v1 vocabulary', () => {
  assert.equal(requestSchemaV2.additionalProperties, false);
  assert.deepEqual(sorted(requestSchemaV2.required), sorted(REQUEST_FIELDS_V2));
  assert.deepEqual(sorted(Object.keys(requestSchemaV2.properties)), sorted(REQUEST_FIELDS_V2));
  assert.deepEqual(requestSchemaV2.properties.operation.const, OPERATIONS_V2[0]);
  assert.deepEqual(
    sorted(Object.keys(requestSchemaV2.properties.target.properties)),
    sorted(TARGET_FIELDS_V2),
  );
  assert.deepEqual(
    sorted(Object.keys(requestSchemaV2.properties.presentation.properties)),
    sorted(PRESENTATION_FIELDS_V2),
  );
  assert.deepEqual(resultSchemaV2.$defs.artifact.properties.role.enum, [...ARTIFACT_ROLES_V2]);
  const completedArtifacts = resultSchemaV2.allOf[0].then.properties.artifacts;
  assert.equal(completedArtifacts.minItems, 5);
  assert.equal(completedArtifacts.maxItems, 5);
  assert.deepEqual(
    sorted(completedArtifacts.allOf.map((gate) => gate.contains.properties.role.const)),
    sorted(ARTIFACT_ROLES_V2),
  );
  assert.equal(completedArtifacts.allOf.every(
    (gate) => gate.minContains === 1 && gate.maxContains === 1,
  ), true);
  assert.equal(
    resultSchemaV2.allOf[0].then.properties.evidence.$ref,
    '#/$defs/readyToPlaceEvidence',
  );
  assert.equal(resultSchemaV2.$defs.readyToPlaceEvidence.additionalProperties, false);
  assert.deepEqual(
    sorted(resultSchemaV2.$defs.readyToPlaceEvidence.required),
    sorted(READY_TO_PLACE_EVIDENCE_FIELDS),
  );
  const preparedVideoBranch = resultSchemaV2.$defs.artifact.oneOf.find(
    (branch) => branch.properties.role.const === 'prepared-video',
  );
  assert.equal(
    preparedVideoBranch.properties.media.allOf[1].properties.codec.const,
    'h264',
  );
  assert.deepEqual(requestSchema.properties.operation.enum, [...OPERATIONS]);
  assert.deepEqual(resultSchema.$defs.artifact.properties.role.enum, [...ARTIFACT_ROLES]);

  const outputDirectory = '/tmp/chipk-v2-schema-test';
  const request = validateRequest({
    contractVersion: 2,
    requestId: 'schema-v2-test',
    operation: 'prepared-video',
    mode: 'test',
    target: { routeId: 'chipk.stock.main-force', stockId: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
    outputDirectory,
  });
  assert.equal(request.contractVersion, 2);
  assert.equal(request.outputDirectory, outputDirectory);
  assert.throws(() => validateRequest({ ...request, fallback: 'raw' }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateRequest({
    ...request,
    operation: 'screenshot',
  }), { code: 'INVALID_REQUEST' });
  assert.throws(() => validateRequest({
    ...request,
    target: { ...request.target, recipeId: 'not-allowed-in-v2' },
  }), { code: 'INVALID_REQUEST' });
});

test('stable presentation config matches its schema-level identity and runtime validator', () => {
  assert.equal(presentationProfilesSchema.additionalProperties, false);
  assert.equal(presentationProfiles.schemaVersion, 1);
  const validated = validateProfilesFile(presentationProfiles);
  assert.equal(validated.profiles.length, 1);
  const profile = validated.profiles[0];
  assert.equal(profile.id, 'chipk.stock-main-force-portrait.v1');
  assert.equal(profile.status, 'ready_to_place');
  assert.deepEqual(profile.routeIds, ['chipk.stock.main-force']);
  assert.deepEqual(profile.stockIds, ['3441']);
  assert.deepEqual(profile.interactions, []);
});

test('artifact role, kind, MIME, path, and media semantics fail closed', () => {
  const screenshot = {
    role: 'screenshot',
    kind: 'image',
    relativePath: 'screenshot.png',
    sha256: hash,
    mimeType: 'image/png',
    media: { width: 402, height: 874 },
  };
  assert.doesNotThrow(() => validateResult(completedResult(screenshot)));
  assert.throws(() => validateResult(completedResult({
    ...screenshot, kind: 'video', mimeType: 'video/mp4',
    media: { codec: 'h264', width: 402, height: 874, durationSeconds: 1 },
  })), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult(completedResult({
    ...screenshot, relativePath: 'folder\\screenshot.png',
  })), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult(completedResult({
    ...screenshot, relativePath: '../screenshot.png',
  })), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult(completedResult({
    ...screenshot, relativePath: './screenshot.png',
  })), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult(completedResult({
    ...screenshot, media: { width: 402, height: 874, durationSeconds: 1 },
  })), { code: 'INVALID_RESULT' });
});

test('result contract rejects incomplete status/error semantics and unsafe requestId', () => {
  const rejected = {
    contractVersion: 1,
    requestId: 'result-test-001',
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'rejected',
    artifacts: [],
    evidence: {},
    error: { code: 'REJECTED', message: 'Rejected.', retryable: false },
  };
  assert.doesNotThrow(() => validateResult(rejected));
  assert.throws(() => validateResult({ ...rejected, error: null }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({ ...rejected, requestId: '../escape' }), { code: 'INVALID_RESULT' });
});

test('v2 result requires exactly the fixed prepared bundle on success and zero artifacts on failure', () => {
  const jsonArtifact = (role, relativePath) => ({
    role, kind: 'json', relativePath, sha256: hash, mimeType: 'application/json',
  });
  const artifacts = [
    {
      role: 'prepared-video', kind: 'video', relativePath: 'ready-to-place/prepared.mp4',
      sha256: hash, mimeType: 'video/mp4',
      media: { codec: 'h264', width: 1206, height: 2622, durationSeconds: 5 },
    },
    {
      role: 'screenshot', kind: 'image', relativePath: 'ready-to-place/screenshot.png',
      sha256: hash, mimeType: 'image/png', media: { width: 1206, height: 2622 },
    },
    jsonArtifact('capture-manifest', 'ready-to-place/capture-manifest.json'),
    jsonArtifact('presentation-plan', 'ready-to-place/presentation-plan.json'),
    jsonArtifact('preparation-manifest', 'ready-to-place/preparation-manifest.json'),
  ];
  const completed = {
    contractVersion: 2,
    requestId: 'result-v2-test',
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'completed',
    artifacts,
    evidence: readyToPlaceEvidence,
    error: null,
  };
  assert.doesNotThrow(() => validateResult(completed));
  assert.throws(() => validateResult({ ...completed, artifacts: artifacts.slice(0, -1) }), {
    code: 'INVALID_RESULT',
  });
  assert.throws(() => validateResult({
    ...completed,
    status: 'failed',
    error: { code: 'FAILED', message: 'Failed.', retryable: false },
  }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({
    ...completed,
    artifacts: [
      ...artifacts.slice(0, -1),
      { ...artifacts.at(-1), role: 'presentation-plan' },
    ],
  }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({
    ...completed,
    artifacts: artifacts.map((artifact) => artifact.role === 'prepared-video'
      ? { ...artifact, media: { ...artifact.media, codec: 'hevc' } }
      : artifact),
  }), { code: 'INVALID_RESULT' });
  const { publication: _publication, ...missingEvidence } = readyToPlaceEvidence;
  assert.throws(() => validateResult({
    ...completed,
    evidence: missingEvidence,
  }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({
    ...completed,
    evidence: { ...readyToPlaceEvidence, diagnosticPath: '/private/staging' },
  }), { code: 'INVALID_RESULT' });
});

test('persona example matches the closed local-only schema shape without a real identity', () => {
  assert.equal(personaSchema.additionalProperties, false);
  assert.deepEqual(sorted(personaSchema.required), ['personas', 'schemaVersion']);
  const item = personaSchema.properties.personas.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(sorted(Object.keys(personaExample.personas[0])), sorted(item.required));
  assert.equal(personaExample.personas[0].approved, false);
  assert.equal(personaExample.personas[0].keychainService, 'replace-locally');
  assert.equal(personaExample.personas[0].keychainAccount, 'replace-locally');
  assert.equal(Object.hasOwn(personaExample.personas[0], 'loginIdentifier'), false);
});
