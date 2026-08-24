'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { validateResult } = require('../src/contract');
const { createProvider } = require('../src/provider');
const {
  RuntimeAdapterError,
  createRuntimeAdapter,
  safeRuntimeFailure,
} = require('../src/runtime-adapter');

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

function preparedRequest(outputDirectory, overrides = {}) {
  return {
    contractVersion: 2,
    requestId: 'provider-prepared-test-001',
    operation: 'prepared-video',
    mode: 'test',
    target: { routeId: 'chipk.stock.main-force', stockId: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
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
  const runtimeAdapter = {
    productionReady: true,
    operations: ['screenshot', 'record', 'prepared-video'],
    catalogVersion: 'test',
    profileCapabilities: [{
      id: 'chipk.stock-main-force-portrait.v1',
      version: 1,
      status: 'ready_to_place',
      sourceKind: 'screenshot',
      routeIds: ['chipk.stock.main-force'],
      stockIds: ['3441'],
      artifactRole: 'prepared-video',
    }],
    execute: async () => ({}),
  };
  const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
  const value = provider.capabilities();
  assert.equal(value.productionReady, true);
  assert.deepEqual(value.operations, ['screenshot', 'record']);
  assert.match(value.executionCommand, /^chipk-capture acquire /);
  assert.deepEqual(value.contractCapabilities, [
    {
      contractVersion: 1,
      operations: ['screenshot', 'record'],
      requestSchema: 'contracts/capture-request.schema.json',
      resultSchema: 'contracts/capture-result.schema.json',
    },
    {
      contractVersion: 2,
      operations: ['prepared-video'],
      requestSchema: 'contracts/capture-request-v2.schema.json',
      resultSchema: 'contracts/capture-result-v2.schema.json',
      presentationProfiles: [{
        id: 'chipk.stock-main-force-portrait.v1',
        version: 1,
        status: 'ready_to_place',
        sourceKind: 'screenshot',
        routeIds: ['chipk.stock.main-force'],
        stockIds: ['3441'],
        artifactRole: 'prepared-video',
      }],
    },
  ]);
  assert.equal(value.contractCapabilities.every((entry) => !Object.hasOwn(entry, 'schemas')), true);
});

function syntheticPreparedRuntime(overrides = {}) {
  return createRuntimeAdapter({
    ...(overrides.fsImpl ? { fsImpl: overrides.fsImpl } : {}),
    environment: runEnvironment,
    captureRoute: async (catalog, input) => {
      const screenshot = pngBytes(1206, 2622);
      fs.writeFileSync(input.output, screenshot, { flag: 'wx' });
      const screenshotSha256 = crypto.createHash('sha256').update(screenshot).digest('hex');
      fs.writeFileSync(input.manifest, `${JSON.stringify({
        schemaVersion: 1,
        capturedAt: '2030-01-02T03:04:05.000Z',
        route: { id: input.route },
        parameters: { stockid: input.stockId, stockname: input.stockName },
        screenshot: { file: path.basename(input.output), sha256: screenshotSha256 },
        verification: {
          expectedTexts: ['主力', '主力買賣超', '3441'],
          matchedTexts: ['主力', '主力買賣超', '3441'],
          contentTexts: {
            expected: ['買賣家數差', '聯一光'],
            observed: overrides.contentMissing ? ['聯一光'] : ['買賣家數差', '聯一光'],
            missing: overrides.contentMissing ? ['買賣家數差'] : [],
          },
        },
        catalogVersion: catalog.catalogVersion,
      }, null, 2)}\n`, { flag: 'wx' });
      overrides.captureObserved?.(input);
      return { verification: { contentTexts: { missing: [] } } };
    },
    preparedRendererOptions: {
      clock: () => Date.parse('2030-01-02T03:04:06.000Z'),
      runFfmpeg: async (_input, output) => {
        if (overrides.renderFailure) throw overrides.renderFailure;
        fs.writeFileSync(output, 'synthetic-ready-to-place-h264', { flag: 'wx' });
        return { version: 'fixture-ffmpeg 1' };
      },
      probeVideo: async () => ({
        codec: 'h264', width: 1206, height: 2622, durationSeconds: 5, fps: 30,
        pixelFormat: 'yuv420p', audioStreamCount: 0,
        ...(overrides.probeOverrides || {}),
      }),
    },
    now: () => new Date('2030-01-02T03:04:00.000Z'),
  });
}

test('v2 prepared-video publishes one fixed five-artifact directory after full validation', async (t) => {
  const outputDirectory = tempDirectory(t);
  let captureInput;
  const provider = createProvider({
    runtimeAdapter: syntheticPreparedRuntime({ captureObserved: (input) => { captureInput = input; } }),
    toolVersion: 'test',
  });
  const result = await provider.acquire(preparedRequest(outputDirectory));
  assert.equal(result.contractVersion, 2);
  assert.equal(result.status, 'completed');
  assert.equal(result.evidence.material, 'ready_to_place');
  assert.equal(result.evidence.publication, 'atomic_directory_rename');
  assert.equal(captureInput.stockName, '聯一光');
  assert.equal(captureInput.requireContentTexts, true);
  assert.deepEqual(result.artifacts.map((artifact) => artifact.role), [
    'prepared-video', 'screenshot', 'capture-manifest',
    'presentation-plan', 'preparation-manifest',
  ]);
  assert.equal(result.artifacts.every((artifact) => artifact.relativePath.startsWith('ready-to-place/')), true);
  assert.deepEqual(fs.readdirSync(outputDirectory), ['ready-to-place']);
  assert.deepEqual(fs.readdirSync(path.join(outputDirectory, 'ready-to-place')).sort(), [
    'capture-manifest.json', 'preparation-manifest.json', 'prepared.mp4',
    'presentation-plan.json', 'screenshot.png',
  ]);
  const plan = JSON.parse(fs.readFileSync(path.join(outputDirectory, 'ready-to-place', 'presentation-plan.json')));
  assert.equal(plan.requestId, 'provider-prepared-test-001');
  assert.equal(plan.timeline.durationSeconds, 5);
  assert.equal(plan.timeline.fps, 30);
  assert.deepEqual(plan.presentation.interactions, []);
  assert.deepEqual(plan.presentation.camera.keyframes.map(({ zoom }) => zoom), [1, 1, 1.1, 1.1]);
  assert.doesNotThrow(() => validateResult(result));
});

test('v2 render failure removes staging and publishes no partial artifact', async (t) => {
  const outputDirectory = tempDirectory(t);
  const error = new Error('synthetic render failure');
  error.code = 'PREPARED_RENDER_FAILED';
  const provider = createProvider({
    runtimeAdapter: syntheticPreparedRuntime({ renderFailure: error }),
    toolVersion: 'test',
  });
  const result = await provider.acquire(preparedRequest(outputDirectory));
  assert.equal(result.contractVersion, 2);
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'PREPARED_RENDER_FAILED');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('v2 content evidence mismatch fails closed and publishes no partial artifact', async (t) => {
  const outputDirectory = tempDirectory(t);
  const provider = createProvider({
    runtimeAdapter: syntheticPreparedRuntime({ contentMissing: true }),
    toolVersion: 'test',
  });
  const result = await provider.acquire(preparedRequest(outputDirectory));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CAPTURE_CONTENT_INCOMPLETE');
  assert.deepEqual(result.artifacts, []);
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('v2 staging cleanup failure is typed without exposing the private staging path', async (t) => {
  const outputDirectory = tempDirectory(t);
  const fsImpl = new Proxy(fs, {
    get(target, property) {
      if (property === 'rmSync') {
        return (targetPath, options) => {
          if (path.basename(targetPath).startsWith('.chipk-ready-to-place-')) {
            const error = new Error('synthetic cleanup denial');
            error.code = 'EACCES';
            throw error;
          }
          return target.rmSync(targetPath, options);
        };
      }
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const renderFailure = new Error('synthetic render failure');
  renderFailure.code = 'PREPARED_RENDER_FAILED';
  const provider = createProvider({
    runtimeAdapter: syntheticPreparedRuntime({ fsImpl, renderFailure }),
    toolVersion: 'test',
  });

  const result = await provider.acquire(preparedRequest(outputDirectory));
  assert.equal(result.status, 'human_action_required');
  assert.equal(result.error.code, 'OUTPUT_ROLLBACK_FAILED');
  assert.deepEqual(result.evidence, {
    publicationState: 'cleanup_required',
    material: 'cleanup_required',
  });
  assert.deepEqual(result.artifacts, []);
  assert.equal(JSON.stringify(result).includes(outputDirectory), false);
  assert.equal(JSON.stringify(result).includes('.chipk-ready-to-place-'), false);
});

test('content text timeout is classified as retryable human action', () => {
  const error = new Error('content was not ready');
  error.code = 'content_text_timeout';
  const failure = safeRuntimeFailure(error);
  assert.equal(failure.code, 'CONTENT_TEXT_TIMEOUT');
  assert.equal(failure.status, 'human_action_required');
  assert.equal(failure.retryable, true);
});

test('provider advertises v2 only for a prepared runtime with a validated profile', () => {
  const v1Only = createProvider({
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record'],
      catalogVersion: 'test',
      execute: async () => ({}),
    },
  });
  assert.deepEqual(
    v1Only.capabilities().contractCapabilities.map(({ contractVersion }) => contractVersion),
    [1],
  );

  assert.throws(() => createProvider({
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record', 'prepared-video'],
      catalogVersion: 'test',
      execute: async () => ({}),
    },
  }), /at least one validated profile/);

  assert.throws(() => createProvider({
    toolVersion: 'test',
    runtimeAdapter: {
      productionReady: true,
      operations: ['screenshot', 'record', 'prepared-video'],
      catalogVersion: 'test',
      profileCapabilities: [{
        id: 'chipk.stock-main-force-portrait.v1',
        version: 1,
        status: 'ready_to_place',
        sourceKind: 'screenshot',
        routeIds: ['chipk.stock.main-force'],
        stockIds: ['2330'],
        artifactRole: 'prepared-video',
      }],
      execute: async () => ({}),
    },
  }), /invalid profile capability/);
});

test('v2 rejects prepared media with audio or the wrong pixel format before publication', async (t) => {
  for (const probeOverrides of [
    { audioStreamCount: 1 },
    { pixelFormat: 'yuv444p' },
  ]) {
    const outputDirectory = tempDirectory(t);
    const provider = createProvider({
      runtimeAdapter: syntheticPreparedRuntime({ probeOverrides }),
      toolVersion: 'test',
    });
    const result = await provider.acquire(preparedRequest(outputDirectory));
    assert.equal(result.status, 'failed');
    assert.equal(result.error.code, 'PREPARED_OUTPUT_INVALID');
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
  }
});

test('v2 rejects unsupported profile, route, stock, and existing final bundle before capture', async (t) => {
  for (const overrides of [
    { presentation: { profileId: 'chipk.unknown.v1' } },
    { target: { routeId: 'chipk.stock.health-check', stockId: '3441' } },
    { target: { routeId: 'chipk.stock.main-force', stockId: '2330' } },
  ]) {
    const outputDirectory = tempDirectory(t);
    let captured = false;
    const runtimeAdapter = syntheticPreparedRuntime({ captureObserved: () => { captured = true; } });
    const provider = createProvider({ runtimeAdapter, toolVersion: 'test' });
    const result = await provider.acquire(preparedRequest(outputDirectory, overrides));
    assert.equal(result.status, 'rejected');
    assert.equal(captured, false);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
  }

  const outputDirectory = tempDirectory(t);
  fs.mkdirSync(path.join(outputDirectory, 'ready-to-place'));
  let captured = false;
  const provider = createProvider({
    runtimeAdapter: syntheticPreparedRuntime({ captureObserved: () => { captured = true; } }),
    toolVersion: 'test',
  });
  const result = await provider.acquire(preparedRequest(outputDirectory));
  assert.equal(result.status, 'rejected');
  assert.equal(result.error.code, 'OUTPUT_EXISTS');
  assert.equal(captured, false);
  assert.deepEqual(fs.readdirSync(outputDirectory), ['ready-to-place']);
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
