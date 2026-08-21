'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateResult } = require('../src/contract');
const { createProvider } = require('../src/provider');
const { RuntimeAdapterError, createRuntimeAdapter } = require('../src/runtime-adapter');

const UDID = '11111111-1111-1111-1111-111111111111';
const runEnvironment = {
  CHIPK_SIMULATOR_UDID: UDID,
  CHIPK_CAPTURE_AUTHORIZED: '1',
  CHIPK_DEDICATED_SIMULATOR_CONFIRMED: '1',
  CHIPK_VIP_SESSION_CONFIRMED: '1',
};

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-provider-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function request(outputDirectory, overrides = {}) {
  return {
    contractVersion: 1,
    requestId: 'provider-test-001',
    operation: 'screenshot',
    mode: 'test',
    target: { routeId: 'chipk.stock.health-check', stockId: '2330', stockName: '台積電' },
    outputDirectory,
    ...overrides,
  };
}

function pngBytes(width = 12, height = 34) {
  const bytes = Buffer.alloc(25);
  Buffer.from('\x89PNG\r\n\x1a\n', 'binary').copy(bytes);
  Buffer.from('IHDR').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test('shipped provider reports actual screenshot and record capabilities', () => {
  const runtimeAdapter = { productionReady: true, operations: ['screenshot', 'record'], catalogVersion: 'test', execute: async () => ({}) };
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const value = provider.capabilities();
  assert.equal(value.productionReady, true);
  assert.deepEqual(value.operations, ['screenshot', 'record']);
  assert.match(value.executionCommand, /^chipk-capture acquire /);
});

test('missing provider-local run configuration is typed and publishes nothing', async (t) => {
  const outputDirectory = tempDirectory(t);
  let invoked = false;
  const runtimeAdapter = createRuntimeAdapter({
    environment: {},
    captureRoute: async () => { invoked = true; },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory));
  assert.equal(result.status, 'human_action_required');
  assert.equal(result.error.code, 'RUNTIME_CONFIGURATION_REQUIRED');
  assert.deepEqual(result.artifacts, []);
  assert.equal(invoked, false);
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('screenshot acquire returns only relative typed artifacts', async (t) => {
  const outputDirectory = tempDirectory(t);
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    captureRoute: async (_catalog, input) => {
      fs.writeFileSync(input.output, pngBytes());
      fs.writeFileSync(input.manifest, '{"schemaVersion":1}\n');
      return { verification: { contentTexts: { missing: [] } } };
    },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.artifacts.map((artifact) => artifact.role), ['screenshot', 'capture-manifest']);
  assert.deepEqual(result.artifacts[0].media, { width: 12, height: 34 });
  assert.equal(result.artifacts.every((artifact) => !path.isAbsolute(artifact.relativePath)), true);
  assert.equal(result.evidence.material, 'captured_content_observed');
  assert.doesNotThrow(() => validateResult(result));
});

test('screenshot with no content evidence stays pending human review', async (t) => {
  const outputDirectory = tempDirectory(t);
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    captureRoute: async (_catalog, input) => {
      fs.writeFileSync(input.output, pngBytes());
      fs.writeFileSync(input.manifest, '{"schemaVersion":1}\n');
      return { verification: { contentTexts: { expected: [], observed: [], missing: [] } } };
    },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory, {
    target: { routeId: 'chipk.index-content.realtime' },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.evidence.material, 'captured_pending_human_review');
});

test('screenshot post-publication validation failure rolls back the fresh exact bundle', async (t) => {
  const outputDirectory = tempDirectory(t);
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    captureRoute: async (_catalog, input) => {
      fs.writeFileSync(input.output, 'not-a-png');
      fs.writeFileSync(input.manifest, '{"schemaVersion":1}\n');
      return { verification: { contentTexts: { missing: [] } } };
    },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'RUNTIME_EXECUTION_FAILED');
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('an existing fixed output is rejected without mutation', async (t) => {
  const outputDirectory = tempDirectory(t);
  const screenshotPath = path.join(outputDirectory, 'screenshot.png');
  fs.writeFileSync(screenshotPath, 'caller-owned');
  let invoked = false;
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    captureRoute: async () => { invoked = true; },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'OUTPUT_EXISTS');
  assert.equal(invoked, false);
  assert.equal(fs.readFileSync(screenshotPath, 'utf8'), 'caller-owned');
  assert.deepEqual(fs.readdirSync(outputDirectory), ['screenshot.png']);
});

test('record acquire returns a complete closed bundle', async (t) => {
  const outputDirectory = tempDirectory(t);
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    recordRecipe: async (_catalog, _recipes, input) => {
      fs.writeFileSync(input.video, 'synthetic-video-bytes');
      fs.writeFileSync(input.actions, '{"schemaVersion":1}\n');
      fs.writeFileSync(input.manifest, JSON.stringify({
        recording: { codec: 'h264', width: 402, height: 874, durationSeconds: 3.25 },
      }));
      return {
        route_selection: 'catalog_recipe_exact_match',
        navigation: 'verified',
        material: 'pending_human_review',
      };
    },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory, {
    operation: 'record',
    target: {
      routeId: 'chipk.stock.kline',
      stockId: '2324',
      stockName: '仁寶',
      recipeId: 'renbao.kline-tab-switch-benchmark',
    },
  }));
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.artifacts.map((artifact) => artifact.role), [
    'raw-video', 'actions', 'recording-manifest',
  ]);
  assert.deepEqual(result.artifacts[0].media, {
    codec: 'h264', width: 402, height: 874, durationSeconds: 3.25,
  });
});

test('record post-publication descriptor failure rolls back the fresh exact bundle', async (t) => {
  const outputDirectory = tempDirectory(t);
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    recordRecipe: async (_catalog, _recipes, input) => {
      fs.writeFileSync(input.video, 'synthetic-video-bytes');
      fs.writeFileSync(input.actions, '{"schemaVersion":1}\n');
      fs.writeFileSync(input.manifest, JSON.stringify({
        recording: { codec: 'h264', width: 0, height: 874, durationSeconds: 3.25 },
      }));
      return {
        route_selection: 'catalog_recipe_exact_match',
        navigation: 'verified',
        material: 'pending_human_review',
      };
    },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(outputDirectory, {
    operation: 'record',
    target: {
      routeId: 'chipk.stock.kline',
      stockId: '2324',
      stockName: '仁寶',
      recipeId: 'renbao.kline-tab-switch-benchmark',
    },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'INVALID_RESULT');
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('record recipe cannot silently replace the requested route or stock', async (t) => {
  let invoked = false;
  const runtimeAdapter = createRuntimeAdapter({
    environment: runEnvironment,
    recordRecipe: async () => { invoked = true; },
  });
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const result = await provider.acquire(request(tempDirectory(t), {
    operation: 'record',
    target: {
      routeId: 'chipk.stock.kline',
      stockId: '2330',
      stockName: '台積電',
      recipeId: 'renbao.kline-tab-switch-benchmark',
    },
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'RECIPE_TARGET_MISMATCH');
  assert.equal(invoked, false);
});

test('provider refuses incomplete completed artifact bundles', async (t) => {
  const provider = createProvider({
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      catalogVersion: 'test',
      execute: async () => ({ artifacts: [], evidence: {} }),
    },
  });
  const result = await provider.acquire(request(tempDirectory(t)));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'INVALID_RUNTIME_RESULT');
});

test('runtime errors never publish private diagnostics', async (t) => {
  const provider = createProvider({
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      catalogVersion: 'test',
      execute: async () => {
        throw new RuntimeAdapterError('DEVICE_BUSY', 'Safe retry message.', {
          status: 'human_action_required', retryable: true,
        });
      },
    },
  });
  const result = await provider.acquire(request(tempDirectory(t)));
  assert.equal(result.status, 'human_action_required');
  assert.equal(result.error.code, 'DEVICE_BUSY');
  assert.equal(result.error.message, 'Safe retry message.');
});
