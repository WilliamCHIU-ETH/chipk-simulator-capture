'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const requestSchema = require('../contracts/capture-request.schema.json');
const resultSchema = require('../contracts/capture-result.schema.json');
const personaSchema = require('../contracts/personas.schema.json');
const personaExample = require('../config/personas.example.json');
const {
  ARTIFACT_KINDS,
  ARTIFACT_ROLES,
  MIME_TYPES,
  MODES,
  OPERATIONS,
  RELATIVE_PATH_PATTERN_SOURCE,
  REQUEST_FIELDS,
  REQUEST_ID_PATTERN_SOURCE,
  ROUTE_ID_PATTERN_SOURCE,
  SHA256_PATTERN_SOURCE,
  TARGET_FIELDS,
  validateRequest,
  validateResult,
} = require('../src/contract');

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
