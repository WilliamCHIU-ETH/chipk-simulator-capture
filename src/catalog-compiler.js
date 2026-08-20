'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { canonicalCatalogDigest, validateCatalog } = require('./catalog');
const { ContractError } = require('./errors');
const { normalizeJsonObject } = require('./json');
const { structuredValueIssues } = require('./sensitive-taxonomy');
const { parseJsonStrict } = require('./strict-json');

const SOURCE_BUNDLE_KEYS = new Set([
  'schemaVersion',
  'catalogVersion',
  'classification',
  'baseUrl',
  'routes',
]);
const SOURCE_ROUTE_KEYS = new Set([
  'id',
  'operations',
  'requiredParams',
  'optionalParams',
  'queryParams',
  'fixedParams',
  'readinessTexts',
]);
const QUERY_PARAM_KEYS = new Set(['name', 'queryName']);
const FIXED_PARAM_KEYS = new Set(['name', 'value']);
const TARGET_PARAMS = Object.freeze(['stockId', 'stockName', 'recipeId']);
const OPERATIONS = Object.freeze(['screenshot', 'record']);
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const TARGET_FILENAME = 'catalog.json';
const REPOSITORY_ROOT = path.resolve(__dirname, '..');
const RUNTIME_DATA_ROOT = path.join(REPOSITORY_ROOT, 'runtime-data');
const SYNTHETIC_FIXTURE_ROOT = path.join(REPOSITORY_ROOT, 'fixtures', 'synthetic');

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} contains unsupported field: ${key}`);
    }
  }
}

function requireString(value, label, pattern = null) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} must be a non-empty string`);
  }
  const normalized = value.trim();
  if (pattern && !pattern.test(normalized)) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} has an unsupported format`);
  }
  return normalized;
}

function scanSourceBundle(value, label = 'source bundle') {
  const [issue] = structuredValueIssues(value, label);
  if (issue) throw new ContractError('PRIVATE_SOURCE_DATA', issue);
}

function normalizeStringList(value, label, allowed = null) {
  if (!Array.isArray(value)) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} must be an array`);
  }
  const result = value.map((item) => requireString(item, label));
  if (allowed && result.some((item) => !allowed.includes(item))) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} contains an unsupported value`);
  }
  if (new Set(result).size !== result.length) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', `${label} contains duplicates`);
  }
  return result;
}

function orderByAllowlist(values, allowlist) {
  return [...values].sort((left, right) => allowlist.indexOf(left) - allowlist.indexOf(right));
}

function validateSourceBundle(input) {
  const bundle = normalizeJsonObject(input, 'source bundle', 'INVALID_SOURCE_BUNDLE');
  scanSourceBundle(bundle);
  requireOnlyKeys(bundle, SOURCE_BUNDLE_KEYS, 'source bundle');
  if (bundle.schemaVersion !== 1) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', 'source bundle schemaVersion must be 1');
  }
  if (!['synthetic', 'production-reviewed'].includes(bundle.classification)) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', 'source bundle classification is unsupported');
  }
  if (!Array.isArray(bundle.routes) || bundle.routes.length === 0) {
    throw new ContractError('INVALID_SOURCE_BUNDLE', 'source bundle routes must be a non-empty array');
  }

  const routeIds = new Set();
  const routes = bundle.routes.map((route, index) => {
    if (!isRecord(route)) {
      throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${index} must be an object`);
    }
    requireOnlyKeys(route, SOURCE_ROUTE_KEYS, `route ${index}`);
    const id = requireString(route.id, `route ${index}.id`, /^chipk\.[A-Za-z0-9._-]+$/);
    if (routeIds.has(id)) throw new ContractError('INVALID_SOURCE_BUNDLE', `duplicate route id: ${id}`);
    routeIds.add(id);

    const operations = normalizeStringList(route.operations, `route ${id}.operations`, OPERATIONS);
    if (operations.length === 0) {
      throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id}.operations must not be empty`);
    }
    const requiredParams = normalizeStringList(
      route.requiredParams,
      `route ${id}.requiredParams`,
      TARGET_PARAMS,
    );
    const optionalParams = normalizeStringList(
      route.optionalParams,
      `route ${id}.optionalParams`,
      TARGET_PARAMS,
    );
    if (requiredParams.some((item) => optionalParams.includes(item))) {
      throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} repeats a required param as optional`);
    }

    if (!Array.isArray(route.queryParams) || !Array.isArray(route.fixedParams)) {
      throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} parameter mappings must be arrays`);
    }
    const acceptedParams = new Set([...requiredParams, ...optionalParams]);
    const queryParams = {};
    const queryNames = new Set();
    for (const [mappingIndex, mapping] of route.queryParams.entries()) {
      if (!isRecord(mapping)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} query mapping ${mappingIndex} must be an object`);
      }
      requireOnlyKeys(mapping, QUERY_PARAM_KEYS, `route ${id} query mapping ${mappingIndex}`);
      const name = requireString(mapping.name, `route ${id} query mapping name`);
      const queryName = requireString(
        mapping.queryName,
        `route ${id} query mapping ${name}`,
        /^[A-Za-z][A-Za-z0-9._-]*$/,
      );
      if (!acceptedParams.has(name)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} maps an undeclared parameter`);
      }
      if (Object.hasOwn(queryParams, name) || queryNames.has(queryName)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} contains duplicate query parameters`);
      }
      queryParams[name] = queryName;
      queryNames.add(queryName);
    }
    for (const name of acceptedParams) {
      if (!Object.hasOwn(queryParams, name)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} has no query mapping for ${name}`);
      }
    }

    const fixedParams = {};
    for (const [fixedIndex, fixed] of route.fixedParams.entries()) {
      if (!isRecord(fixed)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} fixed parameter ${fixedIndex} must be an object`);
      }
      requireOnlyKeys(fixed, FIXED_PARAM_KEYS, `route ${id} fixed parameter ${fixedIndex}`);
      const name = requireString(
        fixed.name,
        `route ${id} fixed parameter name`,
        /^[A-Za-z][A-Za-z0-9._-]*$/,
      );
      const value = requireString(fixed.value, `route ${id} fixed parameter ${name}`);
      if (Object.hasOwn(fixedParams, name)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} contains duplicate fixed parameters`);
      }
      if (queryNames.has(name)) {
        throw new ContractError('INVALID_SOURCE_BUNDLE', `route ${id} fixed parameter collides with a query parameter`);
      }
      fixedParams[name] = value;
    }

    const readinessTexts = normalizeStringList(route.readinessTexts, `route ${id}.readinessTexts`);
    return {
      id,
      operations: orderByAllowlist(operations, OPERATIONS),
      requiredParams: orderByAllowlist(requiredParams, TARGET_PARAMS),
      optionalParams: orderByAllowlist(optionalParams, TARGET_PARAMS),
      queryParams,
      fixedParams,
      readinessTexts: [...readinessTexts].sort(),
    };
  });

  return {
    schemaVersion: 1,
    catalogVersion: requireString(bundle.catalogVersion, 'source bundle catalogVersion'),
    classification: bundle.classification,
    baseUrl: requireString(bundle.baseUrl, 'source bundle baseUrl'),
    routes: routes.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  };
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function compileCatalog(sourceBundle) {
  const normalized = validateSourceBundle(sourceBundle);
  const normalizedCatalog = validateCatalog({ ...normalized, sourceDigest: '0'.repeat(64) });
  const sourceDigest = canonicalCatalogDigest(normalizedCatalog);
  return canonicalize(validateCatalog({ ...normalizedCatalog, sourceDigest }));
}

function compileCatalogBytes(sourceBundle) {
  const catalog = compileCatalog(sourceBundle);
  const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
  return Object.freeze({
    catalog,
    bytes,
    digest: catalog.sourceDigest,
    byteLength: Buffer.byteLength(bytes),
  });
}

function hasParentTraversal(value) {
  return value.replace(/\\/g, '/').split('/').includes('..');
}

function resolveExplicitPath(value, cwd, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) {
    throw new ContractError('INVALID_PATH', `${label} must be an explicit path`);
  }
  if (hasParentTraversal(value)) {
    throw new ContractError('PATH_ESCAPE', `${label} must not contain parent traversal`);
  }
  return path.resolve(cwd, value);
}

function requireCanonicalRealPath(resolved, fsImpl, label) {
  let actual;
  try {
    actual = fsImpl.realpathSync(resolved);
  } catch {
    throw new ContractError('INVALID_PATH', `${label} does not exist`);
  }
  if (path.normalize(actual) !== path.normalize(resolved)) {
    throw new ContractError('PATH_ESCAPE', `${label} must not traverse a symbolic-link boundary`);
  }
  return actual;
}

function isContainedBy(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function requireAllowedInputLocation(resolved, parsed) {
  if (!isContainedBy(REPOSITORY_ROOT, resolved) || isContainedBy(RUNTIME_DATA_ROOT, resolved)) return;
  if (isContainedBy(SYNTHETIC_FIXTURE_ROOT, resolved) && parsed && parsed.classification === 'synthetic') return;
  throw new ContractError(
    'SOURCE_TREE_BOUNDARY',
    'repository inputs must be synthetic fixtures or ignored runtime data',
  );
}

function requireAllowedOutputLocation(resolved) {
  if (!isContainedBy(REPOSITORY_ROOT, resolved) || isContainedBy(RUNTIME_DATA_ROOT, resolved)) return;
  throw new ContractError(
    'SOURCE_TREE_BOUNDARY',
    'repository outputs must stay inside ignored runtime data',
  );
}

function loadSourceBundle(inputPath, cwd = process.cwd(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolved = resolveExplicitPath(inputPath, cwd, 'input');
  let metadata;
  try {
    metadata = fsImpl.lstatSync(resolved);
  } catch {
    throw new ContractError('INVALID_INPUT', 'input must be an existing regular file');
  }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ContractError('INVALID_INPUT', 'input must be a regular non-symbolic-link file');
  }
  requireCanonicalRealPath(resolved, fsImpl, 'input');
  if (metadata.size > MAX_SOURCE_BYTES) {
    throw new ContractError('INVALID_INPUT', 'input exceeds the source bundle size limit');
  }

  let descriptor;
  let content;
  try {
    descriptor = fsImpl.openSync(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fsImpl.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
      throw new ContractError('INVALID_INPUT', 'input changed while it was being opened');
    }
    if (opened.size > MAX_SOURCE_BYTES) {
      throw new ContractError('INVALID_INPUT', 'input exceeds the source bundle size limit');
    }
    content = fsImpl.readFileSync(descriptor, 'utf8');
    if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) {
      throw new ContractError('INVALID_INPUT', 'input exceeds the source bundle size limit');
    }
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('INVALID_INPUT', 'input could not be read safely');
  } finally {
    if (descriptor !== undefined) fsImpl.closeSync(descriptor);
  }

  const parsed = parseJsonStrict(content, 'input', 'INVALID_SOURCE_BUNDLE');
  requireAllowedInputLocation(resolved, parsed);
  return parsed;
}

function pathExistsNoFollow(target, fsImpl) {
  try {
    fsImpl.lstatSync(target);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function validateOutputDirectory(outputPath, cwd = process.cwd(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolved = resolveExplicitPath(outputPath, cwd, 'output directory');
  let metadata;
  try {
    metadata = fsImpl.lstatSync(resolved);
  } catch {
    throw new ContractError('INVALID_OUTPUT', 'output directory must already exist');
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ContractError('INVALID_OUTPUT', 'output directory must be a non-symbolic-link directory');
  }
  requireCanonicalRealPath(resolved, fsImpl, 'output directory');
  requireAllowedOutputLocation(resolved);
  if (typeof process.getuid === 'function' && metadata.uid !== process.getuid()) {
    throw new ContractError('INVALID_OUTPUT', 'output directory must be owned by the current user');
  }
  return resolved;
}

function writeCatalogAtomic(outputDirectory, bytes, cwd = process.cwd(), options = {}) {
  const fsImpl = options.fsImpl || fs;
  const resolvedDirectory = validateOutputDirectory(outputDirectory, cwd, { fsImpl });
  const target = path.join(resolvedDirectory, TARGET_FILENAME);
  const lock = path.join(resolvedDirectory, `.${TARGET_FILENAME}.lock`);
  const nonce = crypto.randomBytes(12).toString('hex');
  const staging = path.join(resolvedDirectory, `.${TARGET_FILENAME}.${process.pid}.${nonce}.tmp`);
  const ready = path.join(resolvedDirectory, `.${TARGET_FILENAME}.${process.pid}.${nonce}.ready`);
  if (pathExistsNoFollow(target, fsImpl)) {
    throw new ContractError('OUTPUT_EXISTS', 'catalog target already exists; overwrite is not allowed');
  }

  let locked = false;
  let descriptor;
  try {
    fsImpl.mkdirSync(lock, { mode: 0o700 });
    locked = true;
    if (pathExistsNoFollow(target, fsImpl)) {
      throw new ContractError('OUTPUT_EXISTS', 'catalog target already exists; overwrite is not allowed');
    }
    descriptor = fsImpl.openSync(staging, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    fsImpl.writeFileSync(descriptor, bytes, 'utf8');
    fsImpl.fsyncSync(descriptor);
    fsImpl.closeSync(descriptor);
    descriptor = undefined;
    if (pathExistsNoFollow(target, fsImpl)) {
      throw new ContractError('OUTPUT_EXISTS', 'catalog target already exists; overwrite is not allowed');
    }
    fsImpl.renameSync(staging, ready);
    try {
      fsImpl.linkSync(ready, target);
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        throw new ContractError('OUTPUT_EXISTS', 'catalog target already exists; overwrite is not allowed');
      }
      throw error;
    }
    fsImpl.unlinkSync(ready);
    return target;
  } catch (error) {
    if (descriptor !== undefined) {
      try { fsImpl.closeSync(descriptor); } catch { /* best-effort descriptor cleanup */ }
    }
    if (pathExistsNoFollow(staging, fsImpl)) {
      try { fsImpl.unlinkSync(staging); } catch { /* preserve the primary error */ }
    }
    if (pathExistsNoFollow(ready, fsImpl)) {
      try { fsImpl.unlinkSync(ready); } catch { /* preserve the primary error */ }
    }
    if (error instanceof ContractError) throw error;
    if (error && error.code === 'EEXIST') {
      throw new ContractError('OUTPUT_BUSY', 'catalog output is already being written');
    }
    throw new ContractError('CATALOG_WRITE_FAILED', 'catalog output could not be published atomically');
  } finally {
    if (locked) {
      try { fsImpl.rmdirSync(lock); } catch { /* a failed cleanup is detected by tests and the next run */ }
    }
  }
}

function refreshCatalog({ inputPath, outputDirectory, cwd = process.cwd(), fsImpl = fs }) {
  const sourceBundle = loadSourceBundle(inputPath, cwd, { fsImpl });
  const compiled = compileCatalogBytes(sourceBundle);
  writeCatalogAtomic(outputDirectory, compiled.bytes, cwd, { fsImpl });
  return Object.freeze({
    digest: compiled.digest,
    byteLength: compiled.byteLength,
    targetFile: TARGET_FILENAME,
  });
}

module.exports = {
  TARGET_FILENAME,
  compileCatalog,
  compileCatalogBytes,
  loadSourceBundle,
  refreshCatalog,
  scanSourceBundle,
  validateOutputDirectory,
  validateSourceBundle,
  writeCatalogAtomic,
};
