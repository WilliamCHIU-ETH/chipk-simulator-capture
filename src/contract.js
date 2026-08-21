'use strict';

const { ContractError } = require('./errors');
const { normalizeJsonObject } = require('./json');

const REQUEST_FIELDS = Object.freeze([
  'contractVersion',
  'requestId',
  'operation',
  'mode',
  'target',
  'outputDirectory',
]);
const TARGET_FIELDS = Object.freeze(['routeId', 'stockId', 'stockName', 'recipeId']);
const OPERATIONS = Object.freeze(['screenshot', 'record']);
const MODES = Object.freeze(['live', 'test']);
const ROUTE_ID_PATTERN_SOURCE = '^chipk\\.[A-Za-z0-9._-]+$';
const NON_BLANK_PATTERN_SOURCE = '.*\\S.*';
const REQUEST_KEYS = new Set(REQUEST_FIELDS);
const TARGET_KEYS = new Set(TARGET_FIELDS);
const RESULT_KEYS = new Set([
  'contractVersion',
  'requestId',
  'provider',
  'status',
  'artifacts',
  'evidence',
  'error',
]);
const PROVIDER_KEYS = new Set(['id', 'toolVersion']);
const ERROR_KEYS = new Set(['code', 'message', 'retryable']);

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

function validateRequest(input) {
  input = normalizeJsonObject(input, 'request', 'INVALID_REQUEST');
  requireOnlyKeys(input, REQUEST_KEYS, 'request');
  if (input.contractVersion !== 1) {
    throw new ContractError('UNSUPPORTED_CONTRACT', 'contractVersion must be 1');
  }

  const requestId = requireString(input.requestId, 'requestId');
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

  return Object.freeze({
    contractVersion: 1,
    requestId,
    operation: input.operation,
    mode: input.mode,
    target: Object.freeze(target),
    outputDirectory: requireString(input.outputDirectory, 'outputDirectory'),
  });
}

function validateResult(input) {
  input = normalizeJsonObject(input, 'result', 'INVALID_RESULT');
  requireOnlyKeys(input, RESULT_KEYS, 'result', 'INVALID_RESULT');
  if (input.contractVersion !== 1) throw new ContractError('INVALID_RESULT', 'result contractVersion must be 1');
  const requestId = requireString(input.requestId, 'result.requestId', 'INVALID_RESULT');
  if (!isRecord(input.provider)) throw new ContractError('INVALID_RESULT', 'result.provider must be an object');
  requireOnlyKeys(input.provider, PROVIDER_KEYS, 'result.provider', 'INVALID_RESULT');
  if (input.provider.id !== 'chipk-simulator-capture') {
    throw new ContractError('INVALID_RESULT', 'result.provider.id is invalid');
  }
  const toolVersion = requireString(input.provider.toolVersion, 'result.provider.toolVersion', 'INVALID_RESULT');
  if (!['completed', 'rejected', 'failed', 'human_action_required'].includes(input.status)) {
    throw new ContractError('INVALID_RESULT', 'result.status is invalid');
  }
  if (!isRecord(input.artifacts) || !isRecord(input.evidence)) {
    throw new ContractError('INVALID_RESULT', 'result artifacts and evidence must be objects');
  }
  if (input.error !== null) {
    if (!isRecord(input.error)) throw new ContractError('INVALID_RESULT', 'result.error must be an object or null');
    requireOnlyKeys(input.error, ERROR_KEYS, 'result.error', 'INVALID_RESULT');
    requireString(input.error.code, 'result.error.code', 'INVALID_RESULT');
    requireString(input.error.message, 'result.error.message', 'INVALID_RESULT');
    if (typeof input.error.retryable !== 'boolean') {
      throw new ContractError('INVALID_RESULT', 'result.error.retryable must be boolean');
    }
  }
  return {
    contractVersion: 1,
    requestId,
    provider: { id: input.provider.id, toolVersion },
    status: input.status,
    artifacts: input.artifacts,
    evidence: input.evidence,
    error: input.error,
  };
}

module.exports = {
  MODES,
  NON_BLANK_PATTERN_SOURCE,
  OPERATIONS,
  REQUEST_FIELDS,
  ROUTE_ID_PATTERN_SOURCE,
  TARGET_FIELDS,
  validateRequest,
  validateResult,
};
