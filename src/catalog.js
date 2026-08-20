'use strict';

const crypto = require('node:crypto');
const { ContractError } = require('./errors');
const { normalizeJsonObject } = require('./json');

const CATALOG_KEYS = new Set([
  'schemaVersion',
  'catalogVersion',
  'classification',
  'sourceDigest',
  'baseUrl',
  'routes',
]);
const ROUTE_KEYS = new Set([
  'id',
  'operations',
  'requiredParams',
  'optionalParams',
  'queryParams',
  'fixedParams',
  'readinessTexts',
]);
const TARGET_PARAMS = new Set(['stockId', 'stockName', 'recipeId']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContractError('INVALID_CATALOG', `${label} contains unsupported field: ${key}`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError('INVALID_CATALOG', `${label} must be a non-empty string`);
  }
  return value.trim();
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!normalized || normalized === 'localhost' || normalized.endsWith('.local')) return true;
  if (normalized.includes(':')) return true;
  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 0
    || parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function validateUrl(value, classification) {
  const text = requireString(value, 'catalog.baseUrl');
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must be an absolute URL');
  }
  if (parsed.username || parsed.password) {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must not contain URL credentials');
  }
  if (parsed.port) throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must not contain a custom port');
  if (classification === 'synthetic') {
    if (parsed.protocol !== 'chipk-fixture:' || !parsed.hostname.endsWith('.invalid')) {
      throw new ContractError('INVALID_CATALOG', 'synthetic catalog must use the chipk-fixture scheme and an .invalid host');
    }
  } else if (!['https:', 'chipk:'].includes(parsed.protocol)) {
    throw new ContractError('INVALID_CATALOG', 'production catalog must use https or the reviewed custom scheme');
  }
  if (isPrivateHostname(parsed.hostname)) {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must not use a private or local hostname');
  }
  return parsed.toString();
}

function validateParamList(value, label) {
  if (!Array.isArray(value)) throw new ContractError('INVALID_CATALOG', `${label} must be an array`);
  const result = value.map((item) => requireString(item, label));
  for (const item of result) {
    if (!TARGET_PARAMS.has(item)) throw new ContractError('INVALID_CATALOG', `${label} contains unsupported param: ${item}`);
  }
  if (new Set(result).size !== result.length) throw new ContractError('INVALID_CATALOG', `${label} contains duplicates`);
  return result;
}

function validateCatalog(input) {
  input = normalizeJsonObject(input, 'catalog', 'INVALID_CATALOG');
  requireOnlyKeys(input, CATALOG_KEYS, 'catalog');
  if (input.schemaVersion !== 1) throw new ContractError('INVALID_CATALOG', 'catalog.schemaVersion must be 1');
  if (!['synthetic', 'production-reviewed'].includes(input.classification)) {
    throw new ContractError('INVALID_CATALOG', 'catalog.classification is unsupported');
  }
  if (input.classification === 'production-reviewed'
    && !/^[a-f0-9]{64}$/.test(String(input.sourceDigest || ''))) {
    throw new ContractError('INVALID_CATALOG', 'production catalog requires a SHA-256 sourceDigest');
  }
  if (!Array.isArray(input.routes) || !input.routes.length) {
    throw new ContractError('INVALID_CATALOG', 'catalog.routes must be a non-empty array');
  }

  const seen = new Set();
  const routes = input.routes.map((route, index) => {
    if (!isRecord(route)) throw new ContractError('INVALID_CATALOG', `route ${index} must be an object`);
    requireOnlyKeys(route, ROUTE_KEYS, `route ${index}`);
    const id = requireString(route.id, `route ${index}.id`);
    if (!/^chipk\.[a-z0-9._-]+$/i.test(id)) throw new ContractError('INVALID_CATALOG', `invalid route id: ${id}`);
    if (seen.has(id)) throw new ContractError('INVALID_CATALOG', `duplicate route id: ${id}`);
    seen.add(id);
    if (!Array.isArray(route.operations) || !route.operations.length
      || route.operations.some((item) => !['screenshot', 'record'].includes(item))) {
      throw new ContractError('INVALID_CATALOG', `route ${id} has invalid operations`);
    }
    const requiredParams = validateParamList(route.requiredParams || [], `route ${id}.requiredParams`);
    const optionalParams = validateParamList(route.optionalParams || [], `route ${id}.optionalParams`);
    if (requiredParams.some((item) => optionalParams.includes(item))) {
      throw new ContractError('INVALID_CATALOG', `route ${id} repeats a required param as optional`);
    }
    if (!isRecord(route.queryParams) || !isRecord(route.fixedParams)) {
      throw new ContractError('INVALID_CATALOG', `route ${id} queryParams and fixedParams must be objects`);
    }
    const acceptedParams = new Set([...requiredParams, ...optionalParams]);
    const fixedParams = {};
    for (const [rawKey, rawValue] of Object.entries(route.fixedParams)) {
      const key = requireString(rawKey, `route ${id}.fixedParams key`);
      const value = requireString(rawValue, `route ${id}.fixedParams.${rawKey}`);
      if (Object.hasOwn(fixedParams, key)) {
        throw new ContractError('INVALID_CATALOG', `route ${id} repeats fixed parameter: ${key}`);
      }
      fixedParams[key] = value;
    }
    const queryParams = {};
    const queryNames = new Set();
    for (const key of Object.keys(route.queryParams)) {
      if (!acceptedParams.has(key)) throw new ContractError('INVALID_CATALOG', `route ${id} maps undeclared param: ${key}`);
      const queryName = requireString(route.queryParams[key], `route ${id}.queryParams.${key}`);
      if (queryNames.has(queryName) || Object.hasOwn(fixedParams, queryName)) {
        throw new ContractError('INVALID_CATALOG', `route ${id} query parameter collision: ${queryName}`);
      }
      queryNames.add(queryName);
      queryParams[key] = queryName;
    }
    for (const key of acceptedParams) {
      if (!Object.hasOwn(route.queryParams, key)) {
        throw new ContractError('INVALID_CATALOG', `route ${id} has no query mapping for: ${key}`);
      }
    }
    const readinessTexts = Array.isArray(route.readinessTexts)
      ? route.readinessTexts.map((item) => requireString(item, `route ${id}.readinessTexts`))
      : [];
    return Object.freeze({
      id,
      operations: Object.freeze([...route.operations]),
      requiredParams: Object.freeze(requiredParams),
      optionalParams: Object.freeze(optionalParams),
      queryParams: Object.freeze(queryParams),
      fixedParams: Object.freeze(fixedParams),
      readinessTexts: Object.freeze(readinessTexts),
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    catalogVersion: requireString(input.catalogVersion, 'catalog.catalogVersion'),
    classification: input.classification,
    sourceDigest: input.sourceDigest || null,
    baseUrl: validateUrl(input.baseUrl, input.classification),
    routes: Object.freeze(routes),
  });
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalCatalogDigest(catalog) {
  const value = normalizeJsonObject(catalog, 'catalog', 'INVALID_CATALOG');
  delete value.sourceDigest;
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

module.exports = { canonicalCatalogDigest, validateCatalog };
