'use strict';

const crypto = require('node:crypto');
const net = require('node:net');
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
const SYNTHETIC_HOSTNAME = 'capture.invalid';

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

function canonicalizeHostname(hostname) {
  return hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

const NON_PUBLIC_HOST_LABELS = new Set([
  'localhost',
  'local',
  'internal',
  'private',
  'non-public',
  'nonpublic',
]);
const NON_PUBLIC_DNS_SUFFIXES = Object.freeze([
  'invalid',
  'test',
  'example',
  'localhost',
  'home.arpa',
  'onion',
  'alt',
  'in-addr.arpa',
  'ip6.arpa',
  'ipv4only.arpa',
  'resolver.arpa',
]);

function ipv4OctetsToInteger(octets) {
  return octets.reduce((value, part) => (value * 256) + Number(part), 0) >>> 0;
}

function ipv4ToInteger(hostname) {
  return ipv4OctetsToInteger(hostname.split('.'));
}

function ipv4InRange(value, baseOctets, prefixLength) {
  const shift = 32 - prefixLength;
  return (value >>> shift) === (ipv4OctetsToInteger(baseOctets) >>> shift);
}

const NON_PUBLIC_IPV4_RANGES = Object.freeze([
  [[0, 0, 0, 0], 8],
  [[10, 0, 0, 0], 8],
  [[100, 64, 0, 0], 10],
  [[127, 0, 0, 0], 8],
  [[169, 254, 0, 0], 16],
  [[172, 16, 0, 0], 12],
  [[192, 0, 0, 0], 24],
  [[192, 0, 2, 0], 24],
  [[192, 88, 99, 0], 24],
  [[192, 168, 0, 0], 16],
  [[198, 18, 0, 0], 15],
  [[198, 51, 100, 0], 24],
  [[203, 0, 113, 0], 24],
  [[224, 0, 0, 0], 4],
  [[240, 0, 0, 0], 4],
]);

function ipv6ToInteger(hostname) {
  const halves = hostname.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8) return null;
  return groups.reduce((value, group) => (value << 16n) | BigInt(`0x${group || '0'}`), 0n);
}

function ipv6InRange(value, base, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  const baseValue = ipv6ToInteger(base);
  return baseValue !== null && (value >> shift) === (baseValue >> shift);
}

const NON_PUBLIC_IPV6_RANGES = Object.freeze([
  ['::', 96],
  ['::ffff:0:0', 96],
  ['64:ff9b::', 96],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 32],
  ['2001:2::', 48],
  ['2001:10::', 28],
  ['2001:20::', 28],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['fec0::', 10],
  ['ff00::', 8],
]);

function isNonPublicHostname(hostname) {
  const normalized = canonicalizeHostname(hostname);
  if (!normalized) return true;
  if (normalized.split('.').some((label) => NON_PUBLIC_HOST_LABELS.has(label))) return true;

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    const value = ipv4ToInteger(normalized);
    return NON_PUBLIC_IPV4_RANGES.some(([baseOctets, prefixLength]) => (
      ipv4InRange(value, baseOctets, prefixLength)
    ));
  }
  if (ipVersion === 6) {
    const value = ipv6ToInteger(normalized);
    return value === null
      || NON_PUBLIC_IPV6_RANGES.some(([base, prefixLength]) => ipv6InRange(value, base, prefixLength));
  }
  return false;
}

function normalizeHostnameForPolicy(hostname) {
  const canonical = canonicalizeHostname(hostname);
  const authority = net.isIP(canonical) === 6 ? `[${canonical}]` : canonical;
  try {
    return canonicalizeHostname(new URL(`http://${authority}/`).hostname);
  } catch {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl hostname is invalid');
  }
}

function isNonPublicDnsNamespace(hostname) {
  if (net.isIP(hostname)) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return true;
  return NON_PUBLIC_DNS_SUFFIXES.some((suffix) => (
    hostname === suffix || hostname.endsWith(`.${suffix}`)
  ));
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
  const hostname = normalizeHostnameForPolicy(parsed.hostname);
  parsed.hostname = net.isIP(hostname) === 6 ? `[${hostname}]` : hostname;
  if (classification === 'synthetic') {
    if (parsed.protocol !== 'chipk-fixture:' || hostname !== SYNTHETIC_HOSTNAME) {
      throw new ContractError(
        'INVALID_CATALOG',
        `synthetic catalog must use chipk-fixture://${SYNTHETIC_HOSTNAME}`,
      );
    }
  } else if (!['https:', 'chipk:'].includes(parsed.protocol)) {
    throw new ContractError('INVALID_CATALOG', 'production catalog must use https or the reviewed custom scheme');
  } else if (isNonPublicDnsNamespace(hostname)) {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must use a public DNS namespace or public IP');
  }
  if (isNonPublicHostname(hostname)) {
    throw new ContractError('INVALID_CATALOG', 'catalog.baseUrl must not use a non-public hostname');
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
