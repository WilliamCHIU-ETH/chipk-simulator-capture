'use strict';

const path = require('node:path');
const { ContractError } = require('./errors');
const { normalizeJsonObject } = require('./json');

const REQUEST_FIELDS = Object.freeze([
  'contractVersion', 'requestId', 'operation', 'mode', 'target', 'outputDirectory',
]);
const TARGET_FIELDS = Object.freeze(['routeId', 'stockId', 'stockName', 'recipeId']);
const OPERATIONS = Object.freeze(['screenshot', 'record']);
const MODES = Object.freeze(['live', 'test']);
const ARTIFACT_ROLES = Object.freeze([
  'screenshot', 'capture-manifest', 'raw-video', 'actions', 'recording-manifest',
]);
const ARTIFACT_KINDS = Object.freeze(['image', 'video', 'json']);
const MIME_TYPES = Object.freeze(['image/png', 'video/mp4', 'application/json']);
const REQUEST_ID_PATTERN_SOURCE = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';
const ROUTE_ID_PATTERN_SOURCE = '^chipk\\.[A-Za-z0-9._-]+$';
const NON_BLANK_PATTERN_SOURCE = '.*\\S.*';
const SHA256_PATTERN_SOURCE = '^[a-f0-9]{64}$';
const RELATIVE_PATH_PATTERN_SOURCE = '^(?!/)(?!.*\\\\)(?!.*(?:^|/)\\.{1,2}(?:/|$))[^/]+(?:/[^/]+)*$';

const REQUEST_KEYS = new Set(REQUEST_FIELDS);
const TARGET_KEYS = new Set(TARGET_FIELDS);
const RESULT_KEYS = new Set([
  'contractVersion', 'requestId', 'provider', 'status', 'artifacts', 'evidence', 'error',
]);
const PROVIDER_KEYS = new Set(['id', 'toolVersion']);
const ERROR_KEYS = new Set(['code', 'message', 'retryable']);
const ARTIFACT_KEYS = new Set(['role', 'kind', 'relativePath', 'sha256', 'mimeType', 'media']);
const MEDIA_KEYS = new Set(['codec', 'width', 'height', 'durationSeconds']);
const ROLE_SEMANTICS = Object.freeze({
  screenshot: Object.freeze({ kind: 'image', mimeType: 'image/png' }),
  'capture-manifest': Object.freeze({ kind: 'json', mimeType: 'application/json' }),
  'raw-video': Object.freeze({ kind: 'video', mimeType: 'video/mp4' }),
  actions: Object.freeze({ kind: 'json', mimeType: 'application/json' }),
  'recording-manifest': Object.freeze({ kind: 'json', mimeType: 'application/json' }),
});

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireOnlyKeys(value, allowed, label, code = 'INVALID_REQUEST') {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractError(code, `${label} contains unsupported field: ${key}`);
    }
  }
}

function requireString(value, label, code = 'INVALID_REQUEST') {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError(code, `${label} must be a non-empty string`);
  }
  return value.trim();
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ContractError('INVALID_RESULT', `${label} must be a positive integer`);
  }
  return value;
}

function validateRequest(input) {
  input = normalizeJsonObject(input, 'request', 'INVALID_REQUEST');
  requireOnlyKeys(input, REQUEST_KEYS, 'request');
  if (input.contractVersion !== 1) {
    throw new ContractError('UNSUPPORTED_CONTRACT', 'contractVersion must be 1');
  }
  const requestId = requireString(input.requestId, 'requestId');
  if (!(new RegExp(REQUEST_ID_PATTERN_SOURCE)).test(requestId)) {
    throw new ContractError('INVALID_REQUEST', 'requestId must be a safe portable identifier');
  }
  if (!OPERATIONS.includes(input.operation)) {
    throw new ContractError('INVALID_REQUEST', 'operation must be screenshot or record');
  }
  if (!MODES.includes(input.mode)) {
    throw new ContractError('INVALID_REQUEST', 'mode must be live or test');
  }
  if (!isRecord(input.target)) {
    throw new ContractError('INVALID_REQUEST', 'target must be an object');
  }
  requireOnlyKeys(input.target, TARGET_KEYS, 'target');
  const routeId = requireString(input.target.routeId, 'target.routeId');
  if (!(new RegExp(ROUTE_ID_PATTERN_SOURCE)).test(routeId)) {
    throw new ContractError('INVALID_REQUEST', 'target.routeId must start with chipk.');
  }
  const target = { routeId };
  for (const key of ['stockId', 'stockName', 'recipeId']) {
    if (input.target[key] !== undefined) target[key] = requireString(input.target[key], `target.${key}`);
  }
  const outputDirectory = requireString(input.outputDirectory, 'outputDirectory');
  if (!path.isAbsolute(outputDirectory)) {
    throw new ContractError('INVALID_REQUEST', 'outputDirectory must be an absolute path');
  }
  const normalizedOutputDirectory = path.normalize(outputDirectory);
  if (normalizedOutputDirectory === path.parse(normalizedOutputDirectory).root) {
    throw new ContractError('INVALID_REQUEST', 'outputDirectory must not be a filesystem root');
  }
  return Object.freeze({
    contractVersion: 1,
    requestId,
    operation: input.operation,
    mode: input.mode,
    target: Object.freeze(target),
    outputDirectory: normalizedOutputDirectory,
  });
}

function validateMedia(input, kind, label) {
  if (!isRecord(input)) throw new ContractError('INVALID_RESULT', `${label} must be an object`);
  requireOnlyKeys(input, MEDIA_KEYS, label, 'INVALID_RESULT');
  const width = requirePositiveInteger(input.width, `${label}.width`);
  const height = requirePositiveInteger(input.height, `${label}.height`);
  if (kind === 'image') {
    if (input.codec !== undefined || input.durationSeconds !== undefined) {
      throw new ContractError('INVALID_RESULT', `${label} image metadata contains video fields`);
    }
    return { width, height };
  }
  const codec = requireString(input.codec, `${label}.codec`, 'INVALID_RESULT');
  if (!Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0) {
    throw new ContractError('INVALID_RESULT', `${label}.durationSeconds must be positive`);
  }
  return { codec, width, height, durationSeconds: input.durationSeconds };
}

function validateArtifact(input, index) {
  const label = `result.artifacts[${index}]`;
  if (!isRecord(input)) throw new ContractError('INVALID_RESULT', `${label} must be an object`);
  requireOnlyKeys(input, ARTIFACT_KEYS, label, 'INVALID_RESULT');
  if (!ARTIFACT_ROLES.includes(input.role)) {
    throw new ContractError('INVALID_RESULT', `${label}.role is invalid`);
  }
  if (!ARTIFACT_KINDS.includes(input.kind)) {
    throw new ContractError('INVALID_RESULT', `${label}.kind is invalid`);
  }
  if (!MIME_TYPES.includes(input.mimeType)) {
    throw new ContractError('INVALID_RESULT', `${label}.mimeType is invalid`);
  }
  const expected = ROLE_SEMANTICS[input.role];
  if (input.kind !== expected.kind || input.mimeType !== expected.mimeType) {
    throw new ContractError('INVALID_RESULT', `${label} role, kind, and mimeType disagree`);
  }
  const relativePath = requireString(input.relativePath, `${label}.relativePath`, 'INVALID_RESULT');
  if (relativePath.includes('\\') || path.posix.isAbsolute(relativePath)
    || relativePath.split('/').some((component) => !component || component === '.' || component === '..')) {
    throw new ContractError('INVALID_RESULT', `${label}.relativePath must stay inside outputDirectory`);
  }
  if (!(new RegExp(SHA256_PATTERN_SOURCE)).test(String(input.sha256 || ''))) {
    throw new ContractError('INVALID_RESULT', `${label}.sha256 is invalid`);
  }
  if (input.kind === 'json' && input.media !== undefined) {
    throw new ContractError('INVALID_RESULT', `${label} JSON artifacts must not contain media metadata`);
  }
  if (input.kind !== 'json' && input.media === undefined) {
    throw new ContractError('INVALID_RESULT', `${label} media metadata is required`);
  }
  return {
    role: input.role,
    kind: input.kind,
    relativePath,
    sha256: input.sha256,
    mimeType: input.mimeType,
    ...(input.media === undefined ? {} : { media: validateMedia(input.media, input.kind, `${label}.media`) }),
  };
}

function validateResult(input) {
  input = normalizeJsonObject(input, 'result', 'INVALID_RESULT');
  requireOnlyKeys(input, RESULT_KEYS, 'result', 'INVALID_RESULT');
  if (input.contractVersion !== 1) throw new ContractError('INVALID_RESULT', 'result contractVersion must be 1');
  const requestId = requireString(input.requestId, 'result.requestId', 'INVALID_RESULT');
  if (!(new RegExp(REQUEST_ID_PATTERN_SOURCE)).test(requestId)) {
    throw new ContractError('INVALID_RESULT', 'result.requestId must be a safe portable identifier');
  }
  if (!isRecord(input.provider)) throw new ContractError('INVALID_RESULT', 'result.provider must be an object');
  requireOnlyKeys(input.provider, PROVIDER_KEYS, 'result.provider', 'INVALID_RESULT');
  if (input.provider.id !== 'chipk-simulator-capture') {
    throw new ContractError('INVALID_RESULT', 'result.provider.id is invalid');
  }
  const toolVersion = requireString(input.provider.toolVersion, 'result.provider.toolVersion', 'INVALID_RESULT');
  if (!['completed', 'rejected', 'failed', 'human_action_required'].includes(input.status)) {
    throw new ContractError('INVALID_RESULT', 'result.status is invalid');
  }
  if (!Array.isArray(input.artifacts)) {
    throw new ContractError('INVALID_RESULT', 'result.artifacts must be an array');
  }
  const artifacts = input.artifacts.map(validateArtifact);
  if (new Set(artifacts.map((artifact) => artifact.role)).size !== artifacts.length
    || new Set(artifacts.map((artifact) => artifact.relativePath)).size !== artifacts.length) {
    throw new ContractError('INVALID_RESULT', 'result.artifacts roles and relative paths must be unique');
  }
  if (!isRecord(input.evidence)) throw new ContractError('INVALID_RESULT', 'result.evidence must be an object');
  if (input.error !== null) {
    if (!isRecord(input.error)) throw new ContractError('INVALID_RESULT', 'result.error must be an object or null');
    requireOnlyKeys(input.error, ERROR_KEYS, 'result.error', 'INVALID_RESULT');
    requireString(input.error.code, 'result.error.code', 'INVALID_RESULT');
    requireString(input.error.message, 'result.error.message', 'INVALID_RESULT');
    if (typeof input.error.retryable !== 'boolean') {
      throw new ContractError('INVALID_RESULT', 'result.error.retryable must be boolean');
    }
  }
  if ((input.status === 'completed') !== (input.error === null)) {
    throw new ContractError('INVALID_RESULT', 'completed results require null error and failures require an error');
  }
  return {
    contractVersion: 1,
    requestId,
    provider: { id: input.provider.id, toolVersion },
    status: input.status,
    artifacts,
    evidence: input.evidence,
    error: input.error,
  };
}

module.exports = {
  ARTIFACT_KINDS, ARTIFACT_ROLES, MIME_TYPES, MODES, NON_BLANK_PATTERN_SOURCE,
  OPERATIONS, RELATIVE_PATH_PATTERN_SOURCE, REQUEST_FIELDS, REQUEST_ID_PATTERN_SOURCE,
  ROUTE_ID_PATTERN_SOURCE, SHA256_PATTERN_SOURCE, TARGET_FIELDS, validateRequest, validateResult,
};
