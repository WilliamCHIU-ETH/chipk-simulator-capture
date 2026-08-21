'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const catalogFixture = require('../fixtures/synthetic/catalog.json');
const requestFixture = require('../fixtures/synthetic/request.json');
const { canonicalCatalogDigest } = require('../src/catalog');
const { validateResult } = require('../src/contract');
const { createProvider } = require('../src/provider');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function productionCatalog() {
  const catalog = clone(catalogFixture);
  catalog.classification = 'production-reviewed';
  catalog.catalogVersion = 'reviewed-test-v1';
  catalog.baseUrl = 'https://example.com/catalog';
  catalog.sourceDigest = canonicalCatalogDigest(catalog);
  return catalog;
}

function loadApprovedProviderForTest(catalog) {
  const trustPath = require.resolve('../src/trust-store');
  const readinessPath = require.resolve('../src/readiness');
  const providerPath = require.resolve('../src/provider');
  const saved = new Map([
    [trustPath, require.cache[trustPath]],
    [readinessPath, require.cache[readinessPath]],
    [providerPath, require.cache[providerPath]],
  ]);
  try {
    require.cache[trustPath] = {
      id: trustPath,
      filename: trustPath,
      loaded: true,
      exports: { APPROVED_PRODUCTION_CATALOG_DIGESTS: Object.freeze([catalog.sourceDigest]) },
    };
    delete require.cache[readinessPath];
    delete require.cache[providerPath];
    return require(providerPath).createProvider;
  } finally {
    for (const [modulePath, cachedModule] of saved) {
      if (cachedModule) require.cache[modulePath] = cachedModule;
      else delete require.cache[modulePath];
    }
  }
}

test('shipped synthetic catalog reports plan-only and not production-ready', () => {
  const provider = createProvider({ catalog: catalogFixture, toolVersion: 'test' });
  const value = provider.capabilities();
  assert.equal(value.productionReady, false);
  assert.deepEqual(value.operations, []);
  assert.equal(value.planningAvailable, true);
  assert.ok(value.readiness.reasons.includes('catalog_is_not_production_reviewed'));
  assert.ok(value.readiness.reasons.includes('runtime_adapter_not_shipped'));
});

test('execution rejects before output creation or runtime invocation', async () => {
  let calls = 0;
  const runtimeAdapter = {
    productionReady: true,
    operations: ['screenshot', 'record'],
    execute: async () => {
      calls += 1;
      throw new Error('must not be called');
    },
  };
  const outputDirectory = path.join(os.tmpdir(), `chipk-source-only-${process.pid}-${Date.now()}`);
  const request = { ...clone(requestFixture), outputDirectory };
  const provider = createProvider({ catalog: catalogFixture, runtimeAdapter, toolVersion: 'test' });
  const result = await provider.execute(request, {
    operatorAuthorized: true,
    dedicatedSimulatorConfirmed: true,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'PRODUCTION_NOT_READY');
  assert.equal(calls, 0);
  assert.equal(fs.existsSync(outputDirectory), false);
});

test('a caller cannot self-promote a catalog into the build trust root', async () => {
  let calls = 0;
  const runtimeAdapter = {
    productionReady: true,
    operations: ['screenshot', 'record'],
    execute: async () => {
      calls += 1;
      return { artifacts: { screenshot: 'fixture.png' }, evidence: { source: 'fake-adapter' } };
    },
  };
  const provider = createProvider({ catalog: productionCatalog(), runtimeAdapter, toolVersion: 'test' });
  assert.equal(provider.capabilities().productionReady, false);
  assert.ok(provider.capabilities().readiness.reasons.includes('catalog_digest_not_approved_by_build'));
  const rejected = await provider.execute(requestFixture, {
    operatorAuthorized: true,
    dedicatedSimulatorConfirmed: true,
  });
  assert.equal(rejected.status, 'rejected');
  assert.ok(rejected.evidence.authorization.reasons.includes('catalog_digest_not_approved_by_build'));
  assert.equal(calls, 0);
});

test('a reviewed catalog becomes not ready after content changes without re-signing its digest', () => {
  const catalog = productionCatalog();
  catalog.routes[0].readinessTexts.push('tampered after review');
  const runtimeAdapter = {
    productionReady: true,
    operations: ['screenshot', 'record'],
    execute: async () => ({ artifacts: {}, evidence: {} }),
  };
  const provider = createProvider({ catalog, runtimeAdapter, toolVersion: 'test' });
  assert.equal(provider.capabilities().productionReady, false);
  assert.ok(provider.capabilities().readiness.reasons.includes('catalog_digest_is_missing_or_invalid'));
});

test('provider snapshots catalog input so later caller mutation cannot change plans', () => {
  const catalog = clone(catalogFixture);
  const runtimeAdapter = {
    productionReady: true,
    operations: ['screenshot', 'record'],
    execute: async () => ({ artifacts: {}, evidence: {} }),
  };
  const provider = createProvider({ catalog, runtimeAdapter, toolVersion: 'test' });
  const before = provider.plan(requestFixture);
  catalog.routes[0].id = 'chipk.fixture.changed-after-review';
  runtimeAdapter.execute = async () => { throw new Error('replacement must not run'); };
  const after = provider.plan(requestFixture);
  assert.deepEqual(after, before);
  assert.equal(after.route.id, 'chipk.fixture.stock-overview');
});

test('result contract rejects arrays and missing provider version', () => {
  const result = {
    contractVersion: 1,
    requestId: 'fixture-result',
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'completed',
    artifacts: {},
    evidence: {},
    error: null,
  };
  assert.deepEqual(validateResult(result), result);
  assert.throws(() => validateResult({ ...result, artifacts: [] }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({ ...result, evidence: [] }), { code: 'INVALID_RESULT' });
  assert.throws(() => validateResult({
    ...result,
    provider: { id: 'chipk-simulator-capture' },
  }), { code: 'INVALID_RESULT' });
});

test('result contract rejects non-JSON objects, custom serializers, and cycles', () => {
  const base = {
    contractVersion: 1,
    requestId: 'fixture-result',
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'completed',
    evidence: {},
    error: null,
  };
  assert.throws(() => validateResult({ ...base, artifacts: { capturedAt: new Date() } }), {
    code: 'INVALID_RESULT',
  });
  assert.throws(() => validateResult({
    ...base,
    artifacts: { custom: { toJSON: () => 'not-an-object' } },
  }), { code: 'INVALID_RESULT' });
  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => validateResult({ ...base, artifacts: cyclic }), { code: 'INVALID_RESULT' });
});

test('a test-only approved build covers authorization and runtime result branches', async () => {
  const catalog = productionCatalog();
  const createApprovedProvider = loadApprovedProviderForTest(catalog);
  const context = { operatorAuthorized: true, dedicatedSimulatorConfirmed: true };
  let calls = 0;
  const successful = createApprovedProvider({
    catalog,
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      execute: async () => {
        calls += 1;
        return { artifacts: { screenshot: 'synthetic.png' }, evidence: { source: 'synthetic' } };
      },
    },
  });
  assert.equal(successful.capabilities().productionReady, true);
  const unauthorized = await successful.execute(requestFixture, { dedicatedSimulatorConfirmed: true });
  assert.equal(unauthorized.status, 'rejected');
  assert.ok(unauthorized.evidence.authorization.reasons.includes('operator_authorization_missing'));
  assert.equal(calls, 0);
  const completed = await successful.execute(requestFixture, context);
  assert.equal(completed.status, 'completed');
  assert.equal(completed.artifacts.screenshot, 'synthetic.png');
  assert.doesNotThrow(() => JSON.stringify(completed));
  assert.equal(calls, 1);

  const throwing = createApprovedProvider({
    catalog,
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      execute: async () => { throw new Error('private adapter detail'); },
    },
  });
  const failed = await throwing.execute(requestFixture, context);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'RUNTIME_ADAPTER_FAILED');
  assert.doesNotMatch(failed.error.message, /private adapter detail/);

  const invalid = createApprovedProvider({
    catalog,
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      execute: async () => ({ artifacts: new Date(), evidence: {} }),
    },
  });
  const invalidResult = await invalid.execute(requestFixture, context);
  assert.equal(invalidResult.status, 'failed');
  assert.equal(invalidResult.error.code, 'INVALID_RUNTIME_RESULT');

  const invalidEnvelope = createApprovedProvider({
    catalog,
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      execute: async () => ({ artifacts: [], evidence: {} }),
    },
  });
  const invalidEnvelopeResult = await invalidEnvelope.execute(requestFixture, context);
  assert.equal(invalidEnvelopeResult.status, 'failed');
  assert.equal(invalidEnvelopeResult.error.code, 'INVALID_RUNTIME_RESULT');
});

test('provider refuses an unversioned result contract at construction', () => {
  assert.throws(() => createProvider({ catalog: catalogFixture }), { code: 'INVALID_PROVIDER' });
});
