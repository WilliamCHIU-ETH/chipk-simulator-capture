'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, readCatalog } = require('./simulator-capture');
const {
  MAESTRO_ENV,
  RecordingError,
  buildMaestroDiagnosticSingleFlow,
  buildMaestroFlow,
  buildMaestroPreparationFlow,
  commandsPathsFromArtifacts,
  createMaestroRunner,
  createSimctlVideoRecorder,
  deriveVideoTimelineCalibration,
  mapDiagnosticSingleFlowEvents,
  openRouteWithSimctl,
  observedForOutput,
  parseArgs,
  parseMaestroTimings,
  planRecipe,
  probeVideo,
  publishArtifactsAtomically,
  readRecipes,
  recordRecipe,
  resolveMaestroSingleFlowRecording,
  runRecordingPreflight,
  validateReviewedLayout,
  validateRecipes,
} = require('./simulator-record');

const UDID = '11111111-1111-1111-1111-111111111111';

function setup() {
  const catalog = readCatalog();
  const recipeFile = readRecipes(catalog);
  const recipe = recipeFile.recipes.find((item) => item.id === 'renbao.kline-main-force-swipe');
  const benchmarkRecipe = recipeFile.recipes.find(
    (item) => item.id === 'renbao.kline-tab-switch-benchmark',
  );
  return { benchmarkRecipe, catalog, recipeFile, recipe };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function tempDir(t, prefix) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

function maestroEventEntry(id, timestamp, duration = 100, status = 'COMPLETED') {
  return {
    command: { runFlowCommand: { label: `recording:${id}` } },
    metadata: {
      status,
      timestamp,
      duration,
      depth: 0,
      evaluatedCommand: { runFlowCommand: { label: `recording:${id}` } },
    },
  };
}

function maestroRecordingEntry(type, timestamp, duration, options = {}) {
  const key = `${type}RecordingCommand`;
  const command = {
    [key]:
      type === 'start'
        ? { path: options.recordingStem || 'start-recording/tab-switch-benchmark' }
        : {},
  };
  return {
    command,
    metadata: {
      status: options.status || 'COMPLETED',
      timestamp,
      duration,
      evaluatedCommand: command,
      ...(options.artifactPath
        ? {
            artifacts: [
              { type: 'START_SCREEN_RECORDING', path: options.artifactPath },
            ],
          }
        : {}),
    },
  };
}

function diagnosticLeafEntry(command, timestamp, duration = 100, status = 'COMPLETED') {
  return {
    command,
    metadata: { status, timestamp, duration, depth: 0, evaluatedCommand: command },
  };
}

function diagnosticAssertEntry(selector, visibility, timeout, timestamp, status = 'COMPLETED') {
  const node = selector.kind === 'id' ? { idRegex: selector.value } : { textRegex: selector.value };
  return diagnosticLeafEntry(
    {
      assertConditionCommand: {
        condition: { [visibility]: node },
        ...(timeout === null ? {} : { timeout }),
        optional: false,
      },
    },
    timestamp,
    100,
    status,
  );
}

function diagnosticCommandFixture(recipe, options = {}) {
  let timestamp = 90000;
  const next = () => {
    const value = timestamp;
    timestamp += 200;
    return value;
  };
  const readiness = recipe.actions.find((action) => action.type === 'readiness');
  const tap = recipe.actions.find((action) => action.type === 'tap');
  const resultAssert = recipe.actions.find((action) => action.type === 'assert');
  const entries = [
    diagnosticLeafEntry({ defineVariablesCommand: { env: {}, optional: false } }, next(), 4),
    diagnosticLeafEntry(
      { applyConfigurationCommand: { config: { appId: 'CMoney.Chipk' }, optional: false } },
      next(),
      1,
    ),
  ];
  if (options.includeOptionalOpen) {
    entries.push(
      diagnosticLeafEntry(
        {
          tapOnElement: {
            selector: { textRegex: '打開', optional: false },
            optional: true,
          },
        },
        next(),
        100,
        options.optionalOpenStatus || 'COMPLETED',
      ),
    );
  }
  for (const selector of readiness.selectors) {
    entries.push(
      diagnosticAssertEntry(
        selector,
        'visible',
        options.numericTimeouts ? readiness.timeoutMs : String(readiness.timeoutMs),
        next(),
      ),
      diagnosticAssertEntry(selector, 'visible', null, next()),
    );
  }
  entries.push(
    diagnosticAssertEntry(
      { kind: 'text', value: '使用 CMoney 帳號登入' },
      'notVisible',
      null,
      next(),
    ),
  );
  const start = maestroRecordingEntry('start', next(), 100, {
    artifactPath: 'startRecording/benchmark.mp4',
  });
  entries.push(start);
  const { interactionWidth, interactionHeight } = tap.execution.reviewedLayout;
  entries.push(
    diagnosticLeafEntry(
      {
        tapOnPointV2Command: {
          point: `${Math.round(tap.execution.point.x * interactionWidth)},${Math.round(
            tap.execution.point.y * interactionHeight,
          )}`,
          optional: false,
        },
      },
      next(),
    ),
    diagnosticLeafEntry(
      {
        waitForAnimationToEndCommand: {
          timeout: options.numericTimeouts ? 3000 : '3000',
          optional: false,
        },
      },
      next(),
      300,
    ),
  );
  for (const selector of resultAssert.selectors) {
    entries.push(
      diagnosticAssertEntry(
        selector,
        'visible',
        options.numericTimeouts ? resultAssert.timeoutMs : String(resultAssert.timeoutMs),
        next(),
      ),
      diagnosticAssertEntry(selector, 'visible', null, next()),
    );
  }
  for (const selector of resultAssert.absentSelectors || []) {
    entries.push(diagnosticAssertEntry(selector, 'notVisible', null, next()));
  }
  entries.push(maestroRecordingEntry('stop', next(), 100));
  return entries;
}

function writeMaestroCommands(root, entries) {
  const runDir = path.join(root, 'timestamp', 'flow');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'commands.json'), JSON.stringify(entries));
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({ entries: [{ kind: 'COMMAND_METADATA', relativePath: 'commands.json' }] }),
  );
  return runDir;
}

function passedRouteEvidence(udid = UDID, url = 'chipk://www.cmoney.tw/allowlisted') {
  return {
    id: 'navigation.open-route',
    status: 'passed',
    startedAtMs: 90000,
    completedAtMs: 90500,
    source: 'xcrun_simctl_openurl_process',
    timingSource: 'local_process_clock',
    precision: 'process_exit_not_in_app_readiness',
    processEvidence: {
      file: 'xcrun',
      args: ['simctl', 'openurl', udid, url],
      exitStatus: 0,
    },
  };
}

function passedRouteOpener(udid, url) {
  return passedRouteEvidence(udid, url);
}

test('strict K-line recipe 保留 allowlisted route 與 long-press/swipe/assert 強 invariant', () => {
  const { catalog, recipeFile, recipe } = setup();
  assert.deepEqual(validateRecipes(recipeFile, catalog), {
    ok: true,
    schemaVersion: 1,
    recipeCount: 2,
    recipeIds: ['renbao.kline-main-force-swipe', 'renbao.kline-tab-switch-benchmark'],
  });
  assert.equal(recipe.profile, 'strict_kline_interaction');
  assert.equal(recipe.routeId, 'chipk.stock.kline');
  assert.deepEqual(recipe.stock, { id: '2324', name: '仁寶' });
  assert.deepEqual(recipe.actions.map((action) => action.type), [
    'readiness',
    'tap',
    'tap',
    'swipe',
    'assert',
    'hold',
  ]);
  assert.deepEqual(recipe.recordingDuration, { targetMs: 12000, minMs: 10000, maxMs: 15000 });
  const taps = recipe.actions.filter((action) => action.type === 'tap');
  assert.equal(taps.length, 2);
  for (const tap of taps) assert.deepEqual(tap.execution.point, tap.touchPoint);
  assert.deepEqual(taps[0].execution.reviewedLayout, {
    deviceName: 'iPhone 17 Pro',
    runtime: 'iOS 26.5',
    orientation: 'portrait',
    screenshotWidth: 1206,
    screenshotHeight: 2622,
    interactionWidth: 402,
    interactionHeight: 874,
  });
  const longPress = taps.find((tap) => tap.execution.longPress === true);
  const swipe = recipe.actions.find((action) => action.type === 'swipe');
  assert.equal(longPress.id, 'long-press-kline-chart');
  assert.deepEqual(longPress.execution.point, { x: 0.8209, y: 0.492 });
  assert.deepEqual(longPress.execution.point, swipe.start);
  assert.equal(swipe.durationMs, 900);
});

test('diagnostic tab-switch benchmark 只含一次可逆 coordinate tap 與 result assert', () => {
  const { benchmarkRecipe, catalog, recipeFile } = setup();
  assert.deepEqual(validateRecipes(recipeFile, catalog).recipeIds, [
    'renbao.kline-main-force-swipe',
    'renbao.kline-tab-switch-benchmark',
  ]);
  assert.equal(benchmarkRecipe.profile, 'diagnostic_tab_switch_benchmark');
  assert.deepEqual(benchmarkRecipe.recordingDuration, {
    targetMs: 3000,
    minMs: 1000,
    maxMs: 60000,
  });
  assert.deepEqual(benchmarkRecipe.actions.map((action) => action.type), [
    'readiness',
    'tap',
    'assert',
  ]);
  const tap = benchmarkRecipe.actions[1];
  assert.equal(tap.execution.strategy, 'reviewed_coordinate');
  assert.notEqual(tap.execution.longPress, true);
  assert.equal(benchmarkRecipe.actions.some((action) => action.type === 'swipe'), false);
  assert.equal(benchmarkRecipe.actions.filter((action) => action.type === 'assert').length, 1);

  const invalid = clone(recipeFile);
  invalid.recipes.find((item) => item.id === benchmarkRecipe.id).actions.splice(2, 0, {
    id: 'forbidden-benchmark-assert',
    type: 'assert',
    selectors: [{ kind: 'text', value: 'K線' }],
    timeoutMs: 1000,
  });
  assert.throws(
    () => validateRecipes(invalid, catalog),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'recipes_invalid' &&
      error.message.includes('diagnostic benchmark'),
  );
});

test('recipe 拒絕未知 route 與 login/inputText/shell 等未允許 action', () => {
  const { catalog, recipeFile } = setup();
  const unknownRoute = clone(recipeFile);
  unknownRoute.recipes[0].routeId = 'chipk.stock.unknown';
  assert.throws(
    () => validateRecipes(unknownRoute, catalog),
    (error) => error instanceof RecordingError && error.code === 'recipes_invalid',
  );

  for (const type of ['login', 'inputText', 'shell']) {
    const unsafe = clone(recipeFile);
    unsafe.recipes[0].actions[1].type = type;
    assert.throws(
      () => validateRecipes(unsafe, catalog),
      (error) =>
        error instanceof RecordingError &&
        error.code === 'recipes_invalid' &&
        error.message.includes(`type 不允許：${type}`),
    );
  }

  const screenshotPixelsAsInteraction = clone(recipeFile);
  const layout = screenshotPixelsAsInteraction.recipes[0].actions.find(
    (action) => action.type === 'tap',
  ).execution.reviewedLayout;
  layout.interactionWidth = layout.screenshotWidth;
  layout.interactionHeight = layout.screenshotHeight;
  assert.throws(
    () => validateRecipes(screenshotPixelsAsInteraction, catalog),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'recipes_invalid' &&
      error.message.includes('screenshot 較大'),
  );

  const noNativeLongPress = clone(recipeFile);
  delete noNativeLongPress.recipes[0].actions.find(
    (action) => action.id === 'long-press-kline-chart',
  ).execution.longPress;
  assert.throws(
    () => validateRecipes(noNativeLongPress, catalog),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'recipes_invalid' &&
      error.message.includes('恰有一個原生 long-press'),
  );

  const detachedLongPress = clone(recipeFile);
  detachedLongPress.recipes[0].actions.find(
    (action) => action.id === 'long-press-kline-chart',
  ).execution.point.x = 0.8;
  assert.throws(
    () => validateRecipes(detachedLongPress, catalog),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'recipes_invalid' &&
      error.message.includes('chart swipe 必須從 long-press point 開始'),
  );
});

test('plan 是 side-effect-free Test Mode 契約且保留 evidence boundary', () => {
  const { catalog, recipeFile } = setup();
  const plan = planRecipe(catalog, recipeFile, 'renbao.kline-main-force-swipe');
  assert.equal(plan.dryRun, true);
  assert.equal(plan.mode, 'test');
  assert.equal(plan.route.id, 'chipk.stock.kline');
  assert.match(plan.navigation.url, /^chipk:\/\/www\.cmoney\.tw\/app\/landing_page\/chipk\?/);
  assert.equal(plan.navigation.parameters.stockid, '2324');
  assert.equal(plan.navigation.parameters.stockname, '仁寶');
  assert.equal(plan.captureGate.vipSessionAttestation, 'human_required');
  assert.equal(plan.captureGate.targetSessionPreflight, 'machine_required_before_recording');
  assert.deepEqual(plan.material.doesNotProve, [
    '精選頁導航',
    '歷史價格或日期與目前畫面一致',
  ]);
  assert.equal(plan.planned.every((event) => event.timing === 'planned_only'), true);
});

test('recording plan 沿用 route 的 root-normalized URL', () => {
  const { catalog, recipeFile, recipe } = setup();
  const route = catalog.routes.find((item) => item.id === recipe.routeId);
  route.requiresRootNavigation = true;

  const plan = planRecipe(catalog, recipeFile, recipe.id);

  assert.equal(plan.route.requiresRootNavigation, true);
  assert.equal(plan.navigation.parameters.noReloadApp, undefined);
  assert.doesNotMatch(plan.navigation.url, /[?&]noReloadApp=/);
  assert.equal(plan.planned[0].url, plan.navigation.url);
});

test('benchmark plan 規劃 pre-record readiness、單一 tap 與 result assert', () => {
  const { catalog, recipeFile } = setup();
  const plan = planRecipe(catalog, recipeFile, 'renbao.kline-tab-switch-benchmark');
  assert.equal(plan.recipe.profile, 'diagnostic_tab_switch_benchmark');
  assert.deepEqual(plan.recordingDuration, { targetMs: 3000, minMs: 1000, maxMs: 60000 });
  assert.deepEqual(plan.planned.map((event) => event.type), [
    'navigation',
    'readiness',
    'tap',
    'assert',
  ]);
  assert.equal(plan.planned.filter((event) => event.type === 'assert').length, 1);
  assert.equal(plan.material.supportsCopy.some((claim) => claim.includes('主力買賣超')), true);
});

test('CLI 嚴格拒絕未知 flag、boolean 值與 unsupported runner 值', async (t) => {
  assert.throws(
    () => parseArgs(['plan', '--udid', UDID]),
    (error) => error instanceof RecordingError && error.code === 'unknown_flag',
  );
  assert.throws(
    () => parseArgs(['record', '--confirm-vip-session=true']),
    (error) => error instanceof RecordingError && error.code === 'invalid_boolean_flag',
  );

  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-runner-test-');
  await assert.rejects(
    () =>
      recordRecipe(catalog, recipeFile, {
        recipe: 'renbao.kline-main-force-swipe',
        runnerName: 'shell',
        udid: UDID,
        confirmVipSession: true,
        video: path.join(dir, 'raw.mp4'),
        actions: path.join(dir, 'actions.json'),
        manifest: path.join(dir, 'manifest.json'),
      }),
    (error) => error instanceof RecordingError && error.code === 'unsupported_runner',
  );
});

test('Maestro pre-record 驗 readiness/session；interaction 以 logical-point 主力 tap、原生 long press、900ms swipe 執行', () => {
  const { catalog, recipe } = setup();
  const routePlan = buildPlan(catalog, {
    route: recipe.routeId,
    mode: recipe.mode,
    stockId: recipe.stock.id,
    stockName: recipe.stock.name,
  });
  const preparation = buildMaestroPreparationFlow(recipe, routePlan, catalog.product.bundleId);
  const interaction = buildMaestroFlow(recipe, routePlan, catalog.product.bundleId);
  assert.doesNotMatch(preparation, /openLink|chipk:\/\//);
  assert.match(preparation, /recording:navigation\.accept-chipk-open-confirmation/);
  assert.match(preparation, /text: "打開"\n\s+optional: true/);
  for (const text of ['K線', '2324', '仁寶', '技術']) assert.match(preparation, new RegExp(text));
  assert.match(preparation, /assertNotVisible:\n\s+text: "使用 CMoney 帳號登入"/);
  assert.doesNotMatch(interaction, /openLink|ready-kline-renbao|使用 CMoney 帳號登入/);
  assert.equal((interaction.match(/point: "143,822"/g) || []).length, 1);
  assert.doesNotMatch(interaction, /point: "[^"]*%"/);
  assert.doesNotMatch(interaction, /point: "440,2504"/);
  assert.match(interaction, /label: "recording-target:reviewed-coordinate"/);
  assert.match(interaction, /longPressOn:\n\s+point: "330,430"/);
  assert.doesNotMatch(interaction, /longPress: true/);
  assert.match(interaction, /start: "330,430"/);
  assert.match(interaction, /end: "110,430"/);
  assert.match(interaction, /duration: 900/);
  assert.doesNotMatch(interaction, /(?:start|end): "(?:82|49|27)%/);
  assert.match(interaction, /text: "買賣家數差"/);
  assert.match(interaction, /text: "K線"/);
  assert.match(interaction, /assertNotVisible:\n\s+text: "籌碼集中"/);
  assert.doesNotMatch(interaction, /assertNotVisible:\n\s+text: "籌碼日報"/);
  assert.doesNotMatch(interaction, /inputText|runScript|evalScript|clearKeychain|clearState|密碼/);
});

test('diagnostic single Flow 完全 flatten，順序固定且不含 runFlow/label', () => {
  const { benchmarkRecipe, catalog } = setup();
  const routePlan = buildPlan(catalog, {
    route: benchmarkRecipe.routeId,
    mode: benchmarkRecipe.mode,
    stockId: benchmarkRecipe.stock.id,
    stockName: benchmarkRecipe.stock.name,
  });
  const yaml = buildMaestroDiagnosticSingleFlow(
    benchmarkRecipe,
    routePlan,
    catalog.product.bundleId,
  );
  const markers = [
    'text: "K線"',
    'text: "技術"',
    'text: "使用 CMoney 帳號登入"',
    '- startRecording:',
    'point: "143,822"',
    '- waitForAnimationToEnd:',
    'text: "主力買賣超"',
    'text: "籌碼集中"',
    '- stopRecording',
  ];
  let previous = -1;
  for (const marker of markers) {
    const index = yaml.indexOf(marker);
    assert.equal(index > previous, true, `${marker} 應依序出現`);
    previous = index;
  }
  assert.equal((yaml.match(/- startRecording:/g) || []).length, 1);
  assert.equal((yaml.match(/^- stopRecording$/gm) || []).length, 1);
  assert.doesNotMatch(yaml, /- stopRecording:\s*(?:\n|$)/);
  assert.equal((yaml.match(/point: "143,822"/g) || []).length, 1);
  assert.match(yaml, /path: "start-recording\/tab-switch-benchmark"/);
  assert.doesNotMatch(yaml, /runFlow:|label:/);
  assert.doesNotMatch(yaml, /text: "打開"|optional: true/);
  assert.match(yaml, /text: "主力買賣超"/);
  assert.match(yaml, /text: "買賣家數差"/);
  assert.match(yaml, /text: "2324"/);
  assert.match(yaml, /text: "K線"/);
  assert.match(yaml, /assertNotVisible:\n\s+text: "籌碼集中"/);
  assert.doesNotMatch(yaml, /simctl|recordVideo|inputText|密碼/);
  assert.throws(
    () =>
      buildMaestroDiagnosticSingleFlow(
        benchmarkRecipe,
        routePlan,
        catalog.product.bundleId,
        '../escape',
      ),
    (error) => error instanceof RecordingError && error.code === 'recording_stem_invalid',
  );
});

test('Maestro artifact parser 從 nested manifest 找 commands.json 並使用 epoch-ms timing', (t) => {
  const dir = tempDir(t, 'simulator-record-maestro-artifacts-');
  const runDir = path.join(dir, '2026-08-20_150736', 'renbao-flow');
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(
    path.join(runDir, 'manifest.json'),
    JSON.stringify({
      entries: [{ kind: 'COMMAND_METADATA', relativePath: 'commands.json' }],
    }),
  );
  const eventEntry = (id, timestamp, duration, sequenceNumber) => ({
    command: { runFlowCommand: { label: `recording:${id}` } },
    metadata: {
      status: 'COMPLETED',
      timestamp,
      duration,
      sequenceNumber,
      depth: 0,
      evaluatedCommand: { runFlowCommand: { label: `recording:${id}` } },
    },
  });
  const entries = [
    eventEntry('navigation.open-route', 1100, 200, 2),
    eventEntry('tap-bottom-main-force', 1500, 400, 3),
    {
      command: { tapOnPointV2Command: { point: '143,822' } },
      metadata: {
        status: 'COMPLETED',
        timestamp: 1600,
        duration: 20,
        sequenceNumber: 4,
        depth: 1,
        evaluatedCommand: { tapOnPointV2Command: { point: '143,822' } },
      },
    },
  ];
  fs.writeFileSync(path.join(runDir, 'commands.json'), JSON.stringify(entries));

  assert.deepEqual(commandsPathsFromArtifacts(dir), [path.join(runDir, 'commands.json')]);
  const parsed = parseMaestroTimings(
    dir,
    ['navigation.open-route', 'tap-bottom-main-force', 'not-observed'],
    1000,
  );
  assert.equal(parsed.commandMetadataFiles, 1);
  assert.equal(parsed.entryCount, 3);
  assert.deepEqual(parsed.observed.map((event) => event.id), [
    'navigation.open-route',
    'tap-bottom-main-force',
  ]);
  assert.equal(parsed.observed[1].startedAtMs, 1500);
  assert.equal(parsed.observed[1].completedAtMs, 1900);
  assert.equal(parsed.observed[1].targetResolution, 'reviewed_coordinate');
  assert.equal(parsed.observed[1].timingSource, 'maestro_commands_json');
});

test('diagnostic runner 接受真實無 label start/stop metadata，且 prepare 後只執行一次 maestro test', async (t) => {
  const { benchmarkRecipe, catalog } = setup();
  const routePlan = buildPlan(catalog, {
    route: benchmarkRecipe.routeId,
    mode: benchmarkRecipe.mode,
    stockId: benchmarkRecipe.stock.id,
    stockName: benchmarkRecipe.stock.name,
  });
  const dir = tempDir(t, 'simulator-record-single-flow-runner-');
  const calls = [];
  const commandRunner = {
    async run(file, args, options) {
      calls.push({ file, args, options });
      if (args[0] === '--version') return { code: 0, stdout: '2.8.0\n', stderr: '' };
      const outputArg = args.find((arg) => arg.startsWith('--test-output-dir='));
      const outputRoot = outputArg.slice('--test-output-dir='.length);
      const entries = diagnosticCommandFixture(benchmarkRecipe, { numericTimeouts: true });
      assert.equal(JSON.stringify(entries).includes('recording:recording.start'), false);
      assert.equal(JSON.stringify(entries).includes('recording:recording.stop'), false);
      const runDir = writeMaestroCommands(outputRoot, entries);
      fs.mkdirSync(path.join(runDir, 'startRecording'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'startRecording', 'benchmark.mp4'), 'video');
      return { code: 0, stdout: '', stderr: '' };
    },
    cancel() {},
  };
  const runner = createMaestroRunner({ commandRunner });
  await runner.prepare();
  const result = await runner.runDiagnosticSingleFlow({
    udid: UDID,
    bundleId: catalog.product.bundleId,
    recipe: benchmarkRecipe,
    routePlan,
    tempDir: dir,
  });
  assert.equal(calls.filter((call) => call.args.includes('test')).length, 1);
  assert.equal(calls.length, 2);
  assert.equal(result.artifactEvidence.flowCount, 1);
  assert.equal(result.artifactEvidence.commandEntryCount, 22);
  assert.equal(result.recording.recordingStartedAtMs, 91900);
  assert.equal(result.recording.stopRequestedAtMs, 94200);
  assert.equal(result.recording.recordingStoppedAtMs, 94300);
  assert.equal(fs.readFileSync(result.recording.videoPath, 'utf8'), 'video');
  assert.deepEqual(
    result.preRecordEvidence.observedEvents.map((event) => event.id),
    ['ready-kline-renbao-benchmark', 'session.login-absent'],
  );
  assert.deepEqual(
    result.observedEvents.map((event) => event.id),
    [
      'tap-bottom-main-force-benchmark',
      'recording.wait-for-animation',
      'assert-tab-switch-main-force-result',
    ],
  );
  assert.equal(result.preRecordEvidence.observedEvents[0].startedAtMs, 90400);
  assert.equal(result.preRecordEvidence.observedEvents[0].completedAtMs, 91500);
  assert.equal(result.observedEvents[0].startedAtMs, 92000);
  assert.equal(result.observedEvents[2].completedAtMs, 94100);
});

test('diagnostic semantic mapper 要求 exact 2 preamble + 20 leaf，拒絕 optional 打開與其他差異', () => {
  const { benchmarkRecipe } = setup();
  const records = (entries) =>
    entries.map((entry) => ({ commandPath: '/tmp/commands.json', entry }));

  const exactEntries = diagnosticCommandFixture(benchmarkRecipe);
  assert.equal(exactEntries.length, 22);
  const exact = mapDiagnosticSingleFlowEvents(records(exactEntries), benchmarkRecipe);
  assert.deepEqual(exact.preRecordEvents.map((event) => event.id), [
    'ready-kline-renbao-benchmark',
    'session.login-absent',
  ]);
  assert.deepEqual(exact.inRecordEvents.map((event) => event.id), [
    'tap-bottom-main-force-benchmark',
    'recording.wait-for-animation',
    'assert-tab-switch-main-force-result',
  ]);
  assert.throws(
    () =>
      mapDiagnosticSingleFlowEvents(
        records(
          diagnosticCommandFixture(benchmarkRecipe, {
            includeOptionalOpen: true,
            optionalOpenStatus: 'SKIPPED',
          }),
        ),
        benchmarkRecipe,
      ),
    (error) => error instanceof RecordingError && error.code === 'runner_evidence_invalid',
  );

  const mutations = [
    {
      name: 'extra',
      code: 'runner_evidence_invalid',
      mutate(entries) {
        entries.splice(-1, 0, diagnosticLeafEntry({ defineVariablesCommand: {} }, 93950));
      },
    },
    {
      name: 'missing',
      code: 'runner_evidence_invalid',
      mutate(entries) {
        entries.splice(3, 1);
      },
    },
    {
      name: 'reorder',
      code: 'session_preflight_failed',
      mutate(entries) {
        [entries[2], entries[4]] = [entries[4], entries[2]];
      },
    },
    {
      name: 'failed-assert',
      code: 'runner_failed',
      mutate(entries) {
        const target = entries.find(
          (entry) =>
            entry.metadata.evaluatedCommand.assertConditionCommand?.condition?.visible
              ?.textRegex === '主力買賣超',
        );
        target.metadata.status = 'FAILED';
      },
    },
  ];
  for (const scenario of mutations) {
    const entries = diagnosticCommandFixture(benchmarkRecipe);
    scenario.mutate(entries);
    assert.throws(
      () => mapDiagnosticSingleFlowEvents(records(entries), benchmarkRecipe),
      (error) => error instanceof RecordingError && error.code === scenario.code,
      scenario.name,
    );
  }
});

test('diagnostic process nonzero 優先回報 bounded sanitized diagnostics，不被空 observed 偽裝成 session gate', async (t) => {
  const { benchmarkRecipe, catalog } = setup();
  const routePlan = buildPlan(catalog, {
    route: benchmarkRecipe.routeId,
    mode: benchmarkRecipe.mode,
    stockId: benchmarkRecipe.stock.id,
    stockName: benchmarkRecipe.stock.name,
  });
  const dir = tempDir(t, 'simulator-record-single-flow-process-fail-');
  const runner = createMaestroRunner({
    commandRunner: {
      async run(_file, args) {
        if (args[0] === '--version') return { code: 0, stdout: '2.8.0', stderr: '' };
        return {
          code: 1,
          signal: null,
          stdout: '',
          stderr: `runner crashed ${'x'.repeat(5000)} token=secret-value`,
        };
      },
      cancel() {},
    },
  });
  await runner.prepare();
  await assert.rejects(
    () =>
      runner.runDiagnosticSingleFlow({
        udid: UDID,
        bundleId: catalog.product.bundleId,
        recipe: benchmarkRecipe,
        routePlan,
        tempDir: dir,
      }),
    (error) => {
      assert.equal(error instanceof RecordingError, true);
      assert.equal(error.code, 'runner_failed');
      assert.equal(error.details.processExitCode, 1);
      assert.equal(error.details.stderrTail.length <= 4096, true);
      assert.doesNotMatch(error.details.stderrTail, /secret-value/);
      assert.match(error.details.outputRoot, /maestro-single-flow-output/);
      return true;
    },
  );
});

test('single-flow recording resolver 拒絕 missing/failed start-stop、traversal 與 missing video', (t) => {
  const dir = tempDir(t, 'simulator-record-single-flow-resolver-');
  const scenarios = [
    {
      name: 'missing-start',
      entries: [maestroRecordingEntry('stop', 2000, 100)],
      code: 'maestro_recording_start_missing',
    },
    {
      name: 'failed-start',
      entries: [
        maestroRecordingEntry('start', 1000, 100, { status: 'FAILED' }),
        maestroRecordingEntry('stop', 2000, 100),
      ],
      code: 'maestro_recording_start_failed',
    },
    {
      name: 'missing-stop',
      entries: [
        maestroRecordingEntry('start', 1000, 100, {
          artifactPath: 'startRecording/raw.mp4',
        }),
      ],
      code: 'maestro_recording_stop_missing',
    },
    {
      name: 'failed-stop',
      entries: [
        maestroRecordingEntry('start', 1000, 100, {
          artifactPath: 'startRecording/raw.mp4',
        }),
        maestroRecordingEntry('stop', 2000, 100, { status: 'FAILED' }),
      ],
      code: 'maestro_recording_stop_failed',
    },
    {
      name: 'traversal',
      entries: [
        maestroRecordingEntry('start', 1000, 100, { artifactPath: '../escape.mp4' }),
        maestroRecordingEntry('stop', 2000, 100),
      ],
      code: 'video_artifact_path_traversal',
    },
    {
      name: 'missing-video',
      entries: [
        maestroRecordingEntry('start', 1000, 100, {
          artifactPath: 'startRecording/raw.mp4',
        }),
        maestroRecordingEntry('stop', 2000, 100),
      ],
      code: 'video_missing',
    },
  ];
  for (const scenario of scenarios) {
    const root = path.join(dir, scenario.name);
    const runDir = writeMaestroCommands(root, scenario.entries);
    if (!['missing-start', 'failed-start', 'traversal', 'missing-video'].includes(scenario.name)) {
      fs.mkdirSync(path.join(runDir, 'startRecording'), { recursive: true });
      fs.writeFileSync(path.join(runDir, 'startRecording', 'raw.mp4'), 'video');
    }
    assert.throws(
      () => resolveMaestroSingleFlowRecording(root),
      (error) => error instanceof RecordingError && error.code === scenario.code,
      scenario.name,
    );
  }
});

test('diagnostic manifest 必須恰有一份 COMMAND_METADATA，拒絕 stale recursive output', (t) => {
  const { benchmarkRecipe } = setup();
  const root = tempDir(t, 'simulator-record-single-flow-stale-metadata-');
  for (const name of ['fresh', 'stale']) {
    const runDir = writeMaestroCommands(
      path.join(root, name),
      diagnosticCommandFixture(benchmarkRecipe),
    );
    fs.mkdirSync(path.join(runDir, 'startRecording'), { recursive: true });
    fs.writeFileSync(path.join(runDir, 'startRecording', 'benchmark.mp4'), 'video');
  }
  assert.throws(
    () => resolveMaestroSingleFlowRecording(root),
    (error) => error instanceof RecordingError && error.code === 'runner_evidence_invalid',
  );
});

test('Maestro runner 使用 2.8 udid/test-output contract、required env 與 command timing', async (t) => {
  const { catalog, recipe } = setup();
  const routePlan = buildPlan(catalog, {
    route: recipe.routeId,
    mode: recipe.mode,
    stockId: recipe.stock.id,
    stockName: recipe.stock.name,
  });
  const dir = tempDir(t, 'simulator-record-maestro-runner-');
  const calls = [];
  let now = 1000;
  const commandRunner = {
    async run(file, args, options) {
      calls.push({ file, args, options });
      if (args[0] === '--version') return { code: 0, stdout: '2.8.0\n', stderr: '' };
      const outputArg = args.find((arg) => arg.startsWith('--test-output-dir='));
      const outputRoot = outputArg.slice('--test-output-dir='.length);
      const runDir = path.join(outputRoot, 'timestamp', 'flow');
      fs.mkdirSync(runDir, { recursive: true });
      const isPreRecord = outputRoot.includes('pre-record');
      const ids = isPreRecord
        ? [
            'navigation.accept-chipk-open-confirmation',
            'ready-kline-renbao',
            'session.login-absent',
          ]
        : [
            'tap-bottom-main-force',
            'long-press-kline-chart',
            'swipe-kline-chart-left',
            'assert-main-force-panel',
          ];
      let eventCursor = isPreRecord ? 500 : now;
      const entries = ids.map((id, index) => {
        const duration = id === 'long-press-kline-chart' ? 3000 : 100;
        const entry = {
          command: { runFlowCommand: { label: `recording:${id}` } },
          metadata: {
            status: 'COMPLETED',
            timestamp: eventCursor,
            duration,
            sequenceNumber: index + 2,
            depth: 0,
            evaluatedCommand: { runFlowCommand: { label: `recording:${id}` } },
          },
        };
        eventCursor += duration + 100;
        return entry;
      });
      if (!isPreRecord) now = eventCursor;
      fs.writeFileSync(path.join(runDir, 'commands.json'), JSON.stringify(entries));
      fs.writeFileSync(
        path.join(runDir, 'manifest.json'),
        JSON.stringify({ entries: [{ kind: 'COMMAND_METADATA', relativePath: 'commands.json' }] }),
      );
      return { code: 0, stdout: '', stderr: '' };
    },
    cancel() {},
  };
  const runner = createMaestroRunner({
    commandRunner,
    clock: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  assert.deepEqual(await runner.prepare(), { name: 'maestro', version: '2.8.0' });
  const preRecord = await runner.preflightTarget({
    udid: UDID,
    bundleId: catalog.product.bundleId,
    recipe,
    routePlan,
    tempDir: dir,
  });
  assert.equal(preRecord.status, 'verified_by_maestro_before_recording');
  assert.deepEqual(preRecord.expectedEventIds, [
    'navigation.accept-chipk-open-confirmation',
    'ready-kline-renbao',
    'session.login-absent',
  ]);
  assert.equal(preRecord.observedEvents.length, 3);
  const result = await runner.run({
    udid: UDID,
    bundleId: catalog.product.bundleId,
    recipe,
    routePlan,
    recordingAnchorMs: 1000,
    tempDir: dir,
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].args.slice(0, 3), ['--no-ansi', `--udid=${UDID}`, 'test']);
  assert.equal(calls[2].args.some((arg) => arg.startsWith('--test-output-dir=')), true);
  assert.equal(calls[2].options.env.DEVELOPER_DIR, MAESTRO_ENV.DEVELOPER_DIR);
  assert.equal(calls[2].options.env.MAESTRO_CLI_NO_ANALYTICS, '1');
  assert.equal(calls[2].options.env.MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED, 'true');
  assert.equal(result.runner.version, '2.8.0');
  assert.equal(result.observedEvents.length, 5);
  const observedLongPress = result.observedEvents.find(
    (event) => event.id === 'long-press-kline-chart',
  );
  assert.equal(observedLongPress.completedAtMs - observedLongPress.startedAtMs, 3000);
  assert.equal(result.observedEvents.at(-1).id, 'hold-main-force-result');
  assert.equal(result.observedEvents.at(-1).timingSource, 'local_hold_clock');
});

test('record success 產生 raw/actions/manifest 並保留同一 0-based timeline 與 hashes', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-success-');
  const videoPath = path.join(dir, 'raw.mp4');
  const actionsPath = path.join(dir, 'actions.json');
  const manifestPath = path.join(dir, 'recording-manifest.json');
  const rawBytes = Buffer.from('fake-h264-video');
  let stopped = false;
  let recorderDestination;
  let stageNow = 200000;
  const eventIds = [
    'tap-bottom-main-force',
    'long-press-kline-chart',
    'swipe-kline-chart-left',
    'assert-main-force-panel',
    'hold-main-force-result',
  ];
  const eventTiming = {
    'tap-bottom-main-force': [101000, 101300],
    'long-press-kline-chart': [101400, 104400],
    'swipe-kline-chart-left': [104500, 105400],
    'assert-main-force-panel': [105500, 105800],
    'hold-main-force-result': [105900, 112000],
  };
  const result = await recordRecipe(
    catalog,
    recipeFile,
    {
      recipe: 'renbao.kline-main-force-swipe',
      runnerName: 'maestro',
      udid: UDID,
      confirmVipSession: true,
      video: videoPath,
      actions: actionsPath,
      manifest: manifestPath,
    },
    {
      stageClock: () => {
        stageNow += 10;
        return stageNow;
      },
      routeOpener: passedRouteOpener,
      preflight: () => ({
        bundle: { id: 'CMoney.Chipk', version: '10.137.0', build: '260813.09' },
        device: { name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-5' },
      }),
      layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
      runner: {
        name: 'maestro',
        async prepare() {
          return { name: 'maestro', version: '2.8.0' };
        },
        async preflightTarget() {
          return {
            status: 'verified_by_maestro_before_recording',
            expectedEventIds: [
              'navigation.accept-chipk-open-confirmation',
              'ready-kline-renbao',
              'session.login-absent',
            ],
            observedEvents: [
              {
                id: 'navigation.accept-chipk-open-confirmation',
                status: 'passed',
                startedAtMs: 90000,
                completedAtMs: 90500,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              },
              {
                id: 'ready-kline-renbao',
                status: 'passed',
                startedAtMs: 90500,
                completedAtMs: 91000,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              },
              {
                id: 'session.login-absent',
                status: 'passed',
                startedAtMs: 91000,
                completedAtMs: 91500,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              },
            ],
            artifactEvidence: { commandMetadataFiles: 1, commandEntryCount: 3 },
          };
        },
        async run() {
          return {
            runner: { name: 'maestro', version: '2.8.0' },
            observedEvents: eventIds.map((id) => ({
              id,
              status: 'passed',
              startedAtMs: eventTiming[id][0],
              completedAtMs: eventTiming[id][1],
              timingSource: id.startsWith('hold-')
                ? 'local_hold_clock'
                : 'maestro_commands_json',
              precision: 'command_metadata_not_touch_frame_exact',
            })),
            artifactEvidence: { commandMetadataFiles: 1, commandEntryCount: 20 },
          };
        },
      },
      videoRecorder: {
        async start({ videoPath: output }) {
          recorderDestination = output;
          fs.writeFileSync(output, rawBytes);
          return {
            startedAtMs: 100000,
            async stop() {
              stopped = true;
              return { stopRequestedAtMs: 113000, stoppedAtMs: 113070 };
            },
          };
        },
      },
      probeVideo: async () => ({
        codec: 'h264',
        durationSeconds: 12,
        width: 1206,
        height: 2622,
      }),
    },
  );
  assert.equal(stopped, true);
  assert.notEqual(recorderDestination, videoPath);
  assert.equal(path.dirname(recorderDestination).startsWith(dir), true);
  assert.equal(result.ok, true);
  assert.equal(result.observedComplete, true);
  const actions = JSON.parse(fs.readFileSync(actionsPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(actions.recording.anchorSemantics, 'simctl_process_spawn_boundary_not_first_video_frame');
  assert.equal(actions.recording.timelineCalibration.estimatedEncoderStartOffsetMs, 1000);
  assert.equal(actions.recording.timelineCalibration.recorderFinalizeElapsedMs, 70);
  assert.equal(actions.observed[0].processStartedOffsetMs, 1000);
  assert.equal(actions.observed[0].processCompletedOffsetMs, 1300);
  assert.equal(actions.observed[0].startedOffsetMs, 0);
  assert.equal(actions.observed[0].completedOffsetMs, 300);
  const observedLongPress = actions.observed.find(
    (event) => event.id === 'long-press-kline-chart',
  );
  assert.equal(observedLongPress.completedOffsetMs - observedLongPress.startedOffsetMs, 3000);
  assert.equal(actions.planned.some((event) => event.id === 'navigation.open-route'), false);
  assert.equal(actions.recording.encodedDurationMs, 12000);
  assert.equal(actions.timing.observedComplete, true);
  assert.equal(manifest.route.id, 'chipk.stock.kline');
  assert.equal(manifest.navigation.status, 'verified_by_simctl_and_maestro_before_recording');
  assert.deepEqual(manifest.navigation.evidenceEventIds, [
    'navigation.open-route',
    'navigation.accept-chipk-open-confirmation',
    'ready-kline-renbao',
    'session.login-absent',
  ]);
  assert.equal(manifest.navigation.eventTrace[0].source, 'xcrun_simctl_openurl_process');
  assert.equal(manifest.navigation.eventTrace[0].timingSource, 'local_process_clock');
  assert.equal(manifest.navigation.eventTrace[1].source, null);
  assert.equal(manifest.navigation.eventTrace[1].timingSource, 'maestro_commands_json');
  assert.equal(manifest.artifactEvidence.preRecord.navigation.file, 'xcrun');
  assert.deepEqual(manifest.artifactEvidence.preRecord.navigation.args.slice(0, 3), [
    'simctl',
    'openurl',
    UDID,
  ]);
  assert.equal(manifest.artifactEvidence.preRecord.maestro.commandMetadataFiles, 1);
  assert.equal(manifest.navigation.rawTimelineOffsets, 'not_applicable_pre_record');
  assert.equal(manifest.material.freshCapture, true);
  assert.equal(manifest.material.reviewStatus, 'pending_human_review');
  assert.equal(manifest.pipelineTimings.semantics, 'process_wall_clock_not_recording_timeline');
  assert.deepEqual(
    manifest.pipelineTimings.stages.map((stage) => stage.stage),
    [
      'runner_prepare',
      'device_preflight',
      'route_navigation',
      'target_readiness',
      'layout_probe',
      'recorder_start',
      'interaction',
      'recorder_finalize',
      'video_probe',
      'artifact_preparation',
    ],
  );
  assert.equal(manifest.pipelineTimings.stages.every((stage) => stage.status === 'passed'), true);
  assert.equal(manifest.pipelineTimings.stages.every((stage) => stage.durationMs === 10), true);
  assert.equal(manifest.pipelineTimings.stages[0].startedAt, new Date(200010).toISOString());
  assert.equal(actions.recording.startedAt, new Date(100000).toISOString());
  assert.equal(manifest.recording.codec, 'h264');
  assert.equal(
    manifest.recording.timelineCalibration.method,
    'align_encoded_end_to_recorder_stop_request',
  );
  assert.equal(manifest.recording.width, 1206);
  assert.equal(
    manifest.artifacts.rawVideo.sha256,
    crypto.createHash('sha256').update(rawBytes).digest('hex'),
  );
  assert.equal(
    manifest.artifacts.actions.sha256,
    crypto.createHash('sha256').update(fs.readFileSync(actionsPath)).digest('hex'),
  );
});

test('diagnostic record 不啟動 external simctl recorder，單次 Flow artifact 通過後原子發布', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-single-flow-success-');
  let externalRecorderStarts = 0;
  const result = await recordRecipe(
    catalog,
    recipeFile,
    {
      recipe: 'renbao.kline-tab-switch-benchmark',
      runnerName: 'maestro',
      udid: UDID,
      confirmVipSession: true,
      video: path.join(dir, 'raw.mp4'),
      actions: path.join(dir, 'actions.json'),
      manifest: path.join(dir, 'recording-manifest.json'),
    },
    {
      routeOpener: passedRouteOpener,
      preflight: () => ({
        bundle: { id: 'CMoney.Chipk', version: '10.137.0', build: '260813.09' },
        device: { name: 'iPhone 17 Pro', state: 'Booted', runtime: 'iOS-26-5' },
      }),
      layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
      runner: {
        async prepare() {
          return { name: 'maestro', version: '2.8.0' };
        },
        async runDiagnosticSingleFlow({ tempDir: runTempDir }) {
          const source = path.join(runTempDir, 'maestro-single-flow-output', 'raw.mp4');
          fs.mkdirSync(path.dirname(source), { recursive: true });
          fs.writeFileSync(source, 'single-flow-video');
          return {
            runner: { name: 'maestro', version: '2.8.0' },
            preRecordEvidence: {
              expectedEventIds: [
                'navigation.accept-chipk-open-confirmation',
                'ready-kline-renbao-benchmark',
                'session.login-absent',
              ],
              observedEvents: [
                maestroEventEntry('navigation.accept-chipk-open-confirmation', 90000).metadata,
              ].map(() => ({
                id: 'navigation.accept-chipk-open-confirmation',
                status: 'passed',
                startedAtMs: 90000,
                completedAtMs: 90100,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              })).concat([
                {
                  id: 'ready-kline-renbao-benchmark',
                  status: 'passed',
                  startedAtMs: 90200,
                  completedAtMs: 90300,
                  timingSource: 'maestro_commands_json',
                  precision: 'command_metadata_not_touch_frame_exact',
                },
                {
                  id: 'session.login-absent',
                  status: 'passed',
                  startedAtMs: 90400,
                  completedAtMs: 90500,
                  timingSource: 'maestro_commands_json',
                  precision: 'command_metadata_not_touch_frame_exact',
                },
              ]),
            },
            observedEvents: [
              {
                id: 'tap-bottom-main-force-benchmark',
                status: 'passed',
                startedAtMs: 101200,
                completedAtMs: 101400,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
                targetResolution: 'reviewed_coordinate',
              },
              {
                id: 'recording.wait-for-animation',
                status: 'passed',
                startedAtMs: 101400,
                completedAtMs: 101900,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              },
              {
                id: 'assert-tab-switch-main-force-result',
                status: 'passed',
                startedAtMs: 102000,
                completedAtMs: 102500,
                timingSource: 'maestro_commands_json',
                precision: 'command_metadata_not_touch_frame_exact',
              },
            ],
            recording: {
              videoPath: source,
              recordingStartedAtMs: 100000,
              stopRequestedAtMs: 104000,
              recordingStoppedAtMs: 104100,
              boundarySemantics: {
                start: 'successful_startRecording_command_completion',
                stopRequest: 'successful_stopRecording_command_start',
                stopComplete: 'successful_stopRecording_command_completion',
              },
            },
            artifactEvidence: { flowCount: 1, commandMetadataFiles: 1 },
          };
        },
      },
      videoRecorder: {
        async start() {
          externalRecorderStarts += 1;
          throw new Error('diagnostic must not start external recorder');
        },
      },
      probeVideo: async () => ({
        codec: 'h264',
        durationSeconds: 3,
        width: 1206,
        height: 2622,
      }),
    },
  );
  assert.equal(result.ok, true);
  assert.equal(externalRecorderStarts, 0);
  assert.deepEqual(
    ['raw.mp4', 'actions.json', 'recording-manifest.json'].map((name) =>
      fs.existsSync(path.join(dir, name)),
    ),
    [true, true, true],
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'recording-manifest.json')));
  assert.deepEqual(
    manifest.pipelineTimings.stages.map((stage) => stage.stage),
    [
      'runner_prepare',
      'device_preflight',
      'route_navigation',
      'layout_probe',
      'single_flow',
      'video_probe',
      'artifact_preparation',
    ],
  );
  assert.equal(manifest.recording.stagingMethod, 'hard_link');
  assert.equal(manifest.recording.timelineCalibration.estimatedEncoderStartOffsetMs, 1000);
  assert.equal(manifest.material.resultAssertion, 'passed_inside_single_maestro_flow');
});

test('diagnostic readiness/result failure 與 duration failure 均零發布', async (t) => {
  const { catalog, recipeFile } = setup();
  for (const scenario of ['readiness', 'result', 'duration']) {
    const dir = tempDir(t, `simulator-record-single-flow-${scenario}-`);
    await assert.rejects(
      () =>
        recordRecipe(
          catalog,
          recipeFile,
          {
            recipe: 'renbao.kline-tab-switch-benchmark',
            runnerName: 'maestro',
            udid: UDID,
            confirmVipSession: true,
            video: path.join(dir, 'raw.mp4'),
            actions: path.join(dir, 'actions.json'),
            manifest: path.join(dir, 'recording-manifest.json'),
          },
          {
            routeOpener: passedRouteOpener,
            preflight: () => ({
              bundle: {},
              device: { name: 'iPhone 17 Pro', runtime: 'iOS-26-5' },
            }),
            layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
            runner: {
              async prepare() {},
              async runDiagnosticSingleFlow({ tempDir: runTempDir }) {
                if (scenario !== 'duration') {
                  throw new RecordingError(
                    `${scenario} failed`,
                    scenario === 'readiness' ? 'session_preflight_failed' : 'runner_failed',
                  );
                }
                const source = path.join(runTempDir, 'maestro-output', 'raw.mp4');
                fs.mkdirSync(path.dirname(source), { recursive: true });
                fs.writeFileSync(source, 'short-video');
                return {
                  preRecordEvidence: { expectedEventIds: [], observedEvents: [] },
                  observedEvents: [],
                  recording: {
                    videoPath: source,
                    recordingStartedAtMs: 1000,
                    stopRequestedAtMs: 1500,
                    recordingStoppedAtMs: 1600,
                  },
                  artifactEvidence: { flowCount: 1 },
                };
              },
            },
            probeVideo: async () => ({
              codec: 'h264',
              durationSeconds: 0.5,
              width: 1206,
              height: 2622,
            }),
          },
        ),
      (error) =>
        error instanceof RecordingError &&
        error.code ===
          (scenario === 'readiness'
            ? 'session_preflight_failed'
            : scenario === 'result'
              ? 'runner_failed'
              : 'recording_duration_out_of_range'),
    );
    assert.deepEqual(
      ['raw.mp4', 'actions.json', 'recording-manifest.json'].map((name) =>
        fs.existsSync(path.join(dir, name)),
      ),
      [false, false, false],
    );
  }
});

test('encoder-start calibration 以 recorder capture elapsed 對齊 encoded timeline，不放寬 tolerance', () => {
  const calibration = deriveVideoTimelineCalibration(100000, 126000, 126070, 24022);
  assert.deepEqual(calibration, {
    method: 'align_encoded_end_to_recorder_stop_request',
    semantics:
      'videoOffsetMs = processOffsetMs - estimatedEncoderStartOffsetMs; positive process-minus-encoded duration is treated as estimated non-encoded startup lead-in',
    assumption:
      'the final encoded frame aligns with the recorder stop-request boundary; estimate is not frame-exact',
    precision: 'process_clock_and_ffprobe_duration_estimate_not_frame_exact',
    processCaptureElapsedMs: 26000,
    encodedDurationMs: 24022,
    processMinusEncodedMs: 1978,
    estimatedEncoderStartOffsetMs: 1978,
    recorderFinalizeElapsedMs: 70,
  });
  const observed = observedForOutput(
    {
      id: 'hold-tab-switch-diagnostic-result',
      status: 'passed',
      startedAtMs: 102700,
      completedAtMs: 125999,
      timingSource: 'local_hold_clock',
      precision: 'process_clock_not_video_frame_exact',
    },
    100000,
    126070,
    24022,
    calibration,
  );
  assert.equal(observed.processCompletedOffsetMs, 25999);
  assert.equal(observed.timelineCalibrationAppliedMs, 1978);
  assert.equal(observed.completedOffsetMs, 24021);
  assert.equal(observed.completedOffsetMs <= 24022 + 1000, true);
});

test('record 在 runner failure 或 SIGINT 時仍 finalize video，且不假裝成功', async (t) => {
  const { catalog, recipeFile } = setup();
  for (const interrupt of [false, true]) {
    const dir = tempDir(t, `simulator-record-finalize-${interrupt}-`);
    const signalEmitter = new EventEmitter();
    let stopCount = 0;
    await assert.rejects(
      () =>
        recordRecipe(
          catalog,
          recipeFile,
          {
            recipe: 'renbao.kline-main-force-swipe',
            runnerName: 'maestro',
            udid: UDID,
            confirmVipSession: true,
            video: path.join(dir, 'raw.mp4'),
            actions: path.join(dir, 'actions.json'),
            manifest: path.join(dir, 'manifest.json'),
          },
          {
            signalEmitter,
            routeOpener: passedRouteOpener,
            preflight: () => ({
              bundle: {},
              device: { name: 'iPhone 17 Pro', runtime: 'iOS-26-5' },
            }),
            layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
            runner: {
              async prepare() {
                return { name: 'maestro', version: '2.8.0' };
              },
              async preflightTarget() {
                return {
                  status: 'verified_by_maestro_before_recording',
                  expectedEventIds: [],
                  observedEvents: [],
                };
              },
              async run() {
                if (interrupt) signalEmitter.emit('SIGINT');
                if (!interrupt) throw new RecordingError('mock failure', 'runner_failed');
                return { observedEvents: [], runner: { name: 'maestro', version: '2.8.0' } };
              },
              cancel() {},
            },
            videoRecorder: {
              async start({ videoPath }) {
                fs.writeFileSync(videoPath, 'partial-but-finalized');
                return {
                  startedAtMs: 1000,
                  async stop() {
                    stopCount += 1;
                    return { stoppedAtMs: 2000 };
                  },
                };
              },
            },
          },
        ),
      (error) =>
        error instanceof RecordingError &&
        error.code === (interrupt ? 'recording_interrupted' : 'runner_failed'),
    );
    assert.equal(stopCount, 1);
    assert.equal(fs.existsSync(path.join(dir, 'raw.mp4')), false);
    assert.equal(fs.existsSync(path.join(dir, 'actions.json')), false);
    assert.equal(fs.existsSync(path.join(dir, 'manifest.json')), false);
    assert.equal(signalEmitter.listenerCount('SIGINT'), 0);
    assert.equal(signalEmitter.listenerCount('SIGTERM'), 0);
  }
});

test('simctl recorder 使用 exact UDID、H.264，並以 SIGINT finalize', async () => {
  const calls = [];
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    calls.push({ kill: signal });
    queueMicrotask(() => child.emit('close', 0, signal));
    return true;
  };
  const recorder = createSimctlVideoRecorder({
    clock: () => 12345,
    spawn(file, args, options) {
      calls.push({ file, args, options });
      queueMicrotask(() => child.emit('spawn'));
      return child;
    },
  });
  const handle = await recorder.start({ udid: UDID, videoPath: '/tmp/raw.mp4' });
  assert.equal(handle.startedAtMs, 12345);
  assert.deepEqual(calls[0].file, 'xcrun');
  assert.deepEqual(calls[0].args, [
    'simctl',
    'io',
    UDID,
    'recordVideo',
    '--codec=h264',
    '/tmp/raw.mp4',
  ]);
  await handle.stop();
  assert.deepEqual(calls[1], { kill: 'SIGINT' });
});

test('record 在任何 runner/preflight/Simulator 動作前拒絕覆寫與缺少 VIP 確認', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-gates-');
  const existing = path.join(dir, 'raw.mp4');
  fs.writeFileSync(existing, 'keep');
  let prepareCount = 0;
  let preflightCount = 0;
  const deps = {
    runner: {
      async prepare() {
        prepareCount += 1;
      },
    },
    preflight: () => {
      preflightCount += 1;
    },
  };
  await assert.rejects(
    () =>
      recordRecipe(
        catalog,
        recipeFile,
        {
          recipe: 'renbao.kline-main-force-swipe',
          udid: UDID,
          confirmVipSession: true,
          video: existing,
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        deps,
      ),
    (error) => error instanceof RecordingError && error.code === 'output_exists',
  );
  assert.equal(prepareCount, 0);
  assert.equal(preflightCount, 0);
  assert.equal(fs.readFileSync(existing, 'utf8'), 'keep');

  await assert.rejects(
    () =>
      recordRecipe(catalog, recipeFile, {
        recipe: 'renbao.kline-main-force-swipe',
        udid: UDID,
        video: path.join(dir, 'new.mp4'),
        actions: path.join(dir, 'new-actions.json'),
        manifest: path.join(dir, 'new-manifest.json'),
      }),
    (error) =>
      error instanceof RecordingError && error.code === 'vip_session_confirmation_required',
  );
  assert.equal(prepareCount, 0);
  assert.equal(preflightCount, 0);
});

test('recording preflight 要求 exact Booted device 並保存 bundle metadata', () => {
  const { catalog } = setup();
  const exec = (file, args) => {
    if (file === 'xcrun' && args[1] === 'list') {
      return JSON.stringify({
        devices: {
          'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
            { udid: UDID, name: 'iPhone Test', state: 'Booted', isAvailable: true },
          ],
        },
      });
    }
    if (file === 'xcrun' && args[1] === 'get_app_container') return '/tmp/ChipK.app';
    if (file === 'plutil' && args[1] === 'CFBundleShortVersionString') return '10.137.0';
    if (file === 'plutil' && args[1] === 'CFBundleVersion') return '260813.09';
    throw new Error(`unexpected command ${file} ${args.join(' ')}`);
  };
  assert.deepEqual(runRecordingPreflight(catalog, UDID, { exec }), {
    ok: true,
    udid: UDID,
    device: {
      name: 'iPhone Test',
      state: 'Booted',
      runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5',
    },
    bundle: { id: 'CMoney.Chipk', version: '10.137.0', build: '260813.09' },
  });
  assert.throws(
    () => runRecordingPreflight(catalog, 'booted', { exec }),
    (error) => error instanceof RecordingError && error.code === 'invalid_udid',
  );
});

test('target-first navigation 用 exact UDID 與 allowlisted URL 執行 simctl openurl，並回傳 local process evidence', () => {
  const calls = [];
  const url =
    'chipk://www.cmoney.tw/app/landing_page/chipk?page=stock&subpage=2&stockid=2324&stockname=%E4%BB%81%E5%AF%B6';
  const times = [1000, 1250];
  const evidence = openRouteWithSimctl(UDID, url, {
    clock: () => times.shift(),
    exec(file, args) {
      calls.push({ file, args });
      return '';
    },
  });
  assert.deepEqual(calls, [
    { file: 'xcrun', args: ['simctl', 'openurl', UDID, url] },
  ]);
  assert.deepEqual(evidence, {
    id: 'navigation.open-route',
    status: 'passed',
    startedAtMs: 1000,
    completedAtMs: 1250,
    source: 'xcrun_simctl_openurl_process',
    timingSource: 'local_process_clock',
    precision: 'process_exit_not_in_app_readiness',
    processEvidence: {
      file: 'xcrun',
      args: ['simctl', 'openurl', UDID, url],
      exitStatus: 0,
    },
  });
  assert.throws(
    () => openRouteWithSimctl('booted', url, { exec() {} }),
    (error) => error instanceof RecordingError && error.code === 'invalid_udid',
  );
});

test('simctl openurl nonzero 時 fail closed，不執行 Maestro readiness、不啟動錄影、不發布 final artifacts', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-openurl-fail-');
  let targetPreflightCount = 0;
  let recorderStarts = 0;
  await assert.rejects(
    () =>
      recordRecipe(
        catalog,
        recipeFile,
        {
          recipe: 'renbao.kline-main-force-swipe',
          runnerName: 'maestro',
          udid: UDID,
          confirmVipSession: true,
          video: path.join(dir, 'raw.mp4'),
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        {
          preflight: () => ({ bundle: {}, device: {} }),
          exec(file, args) {
            assert.equal(file, 'xcrun');
            assert.deepEqual(args.slice(0, 3), ['simctl', 'openurl', UDID]);
            throw new Error('simctl exited 1');
          },
          runner: {
            async prepare() {
              return { name: 'maestro', version: '2.8.0' };
            },
            async preflightTarget() {
              targetPreflightCount += 1;
            },
          },
          videoRecorder: {
            async start() {
              recorderStarts += 1;
            },
          },
        },
      ),
    (error) => {
      assert.equal(error instanceof RecordingError, true);
      assert.equal(error.code, 'route_open_failed');
      assert.deepEqual(
        error.details.pipelineTimings.stages.map((stage) => [stage.stage, stage.status]),
        [
          ['runner_prepare', 'passed'],
          ['device_preflight', 'passed'],
          ['route_navigation', 'failed'],
        ],
      );
      assert.equal(
        error.details.pipelineTimings.stages.every(
          (stage) => stage.startedAt && stage.completedAt && Number.isFinite(stage.durationMs),
        ),
        true,
      );
      return true;
    },
  );
  assert.equal(targetPreflightCount, 0);
  assert.equal(recorderStarts, 0);
  assert.deepEqual(
    ['raw.mp4', 'actions.json', 'manifest.json'].map((name) => fs.existsSync(path.join(dir, name))),
    [false, false, false],
  );
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.chipk-simulator-record-')), false);
});

test('ffprobe 驗證 H.264 codec、duration 與 dimensions', () => {
  assert.deepEqual(
    probeVideo('/tmp/raw.mp4', () =>
      JSON.stringify({
        streams: [{ codec_name: 'h264', width: 1206, height: 2622, duration: '5.25' }],
        format: { duration: '5.25' },
      }),
    ),
    { codec: 'h264', durationSeconds: 5.25, width: 1206, height: 2622 },
  );
  assert.throws(
    () =>
      probeVideo('/tmp/raw.mp4', () =>
        JSON.stringify({ streams: [{ codec_name: 'hevc', width: 1206, height: 2622, duration: 5 }] }),
      ),
    (error) => error instanceof RecordingError && error.code === 'video_probe_invalid',
  );
});

test('登入失效或 target/default 技術 context preflight 失敗時，不啟動 recorder、不發布 artifacts', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-session-gate-');
  let recorderStarts = 0;
  let layoutProbes = 0;
  await assert.rejects(
    () =>
      recordRecipe(
        catalog,
        recipeFile,
        {
          recipe: 'renbao.kline-main-force-swipe',
          runnerName: 'maestro',
          udid: UDID,
          confirmVipSession: true,
          video: path.join(dir, 'raw.mp4'),
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        {
          routeOpener: passedRouteOpener,
          preflight: () => ({ bundle: {}, device: {} }),
          runner: {
            async prepare() {
              return { name: 'maestro', version: '2.8.0' };
            },
            async preflightTarget() {
              throw new RecordingError(
                '登入按鈕可見或技術 context 不存在',
                'session_preflight_failed',
              );
            },
          },
          layoutProbe: async () => {
            layoutProbes += 1;
          },
          videoRecorder: {
            async start() {
              recorderStarts += 1;
            },
          },
        },
      ),
    (error) => error instanceof RecordingError && error.code === 'session_preflight_failed',
  );
  assert.equal(recorderStarts, 0);
  assert.equal(layoutProbes, 0);
  for (const name of ['raw.mp4', 'actions.json', 'manifest.json']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false);
  }
  assert.equal(fs.readdirSync(dir).some((name) => name.startsWith('.chipk-simulator-record-')), false);
});

test('requiresRootNavigation route 拒絕 --current-target，且在 opener、runner、preflight 前 fail closed', async (t) => {
  const { catalog, recipeFile } = setup();
  const rootNavigationCatalog = clone(catalog);
  const route = rootNavigationCatalog.routes.find((item) => item.id === 'chipk.stock.kline');
  route.requiresRootNavigation = true;
  const dir = tempDir(t, 'simulator-record-root-navigation-gate-');
  const calls = { opener: 0, prepare: 0, preflight: 0 };

  await assert.rejects(
    () =>
      recordRecipe(
        rootNavigationCatalog,
        recipeFile,
        {
          recipe: 'renbao.kline-main-force-swipe',
          runnerName: 'maestro',
          udid: UDID,
          confirmVipSession: true,
          currentTarget: true,
          video: path.join(dir, 'raw.mp4'),
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        {
          routeOpener() {
            calls.opener += 1;
          },
          preflight() {
            calls.preflight += 1;
          },
          runner: {
            async prepare() {
              calls.prepare += 1;
            },
          },
        },
      ),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'root_navigation_required' &&
      error.details?.routeId === 'chipk.stock.kline',
  );

  assert.deepEqual(calls, { opener: 0, prepare: 0, preflight: 0 });
  for (const name of ['raw.mp4', 'actions.json', 'manifest.json']) {
    assert.equal(fs.existsSync(path.join(dir, name)), false);
  }
  assert.equal(fs.readdirSync(dir).length, 0);
});

test('default Maestro target preflight 對 login/缺少 技術 assertion 的 nonzero flow fail closed', async (t) => {
  const { catalog, recipe } = setup();
  const routePlan = buildPlan(catalog, {
    route: recipe.routeId,
    mode: recipe.mode,
    stockId: recipe.stock.id,
    stockName: recipe.stock.name,
  });
  const dir = tempDir(t, 'simulator-record-default-session-gate-');
  const commandRunner = {
    async run(_file, args) {
      if (args[0] === '--version') return { code: 0, stdout: '2.8.0', stderr: '' };
      return { code: 1, stdout: '', stderr: 'assertion failed' };
    },
    cancel() {},
  };
  const runner = createMaestroRunner({ commandRunner });
  await runner.prepare();
  await assert.rejects(
    () =>
      runner.preflightTarget({
        udid: UDID,
        bundleId: catalog.product.bundleId,
        recipe,
        routePlan,
        tempDir: dir,
      }),
    (error) => error instanceof RecordingError && error.code === 'session_preflight_failed',
  );
});

test('reviewed layout 分離 screenshot pixels 與 Maestro logical points，probe 只驗 1206x2622', async (t) => {
  const { catalog, recipeFile, recipe } = setup();
  const exactPreflight = {
    bundle: {},
    device: { name: 'iPhone 17 Pro', runtime: 'com.apple.CoreSimulator.SimRuntime.iOS-26-5' },
  };
  assert.equal(
    validateReviewedLayout(recipe, exactPreflight, {
      width: 1206,
      height: 2622,
      orientation: 'portrait',
    }).verified,
    true,
  );
  assert.throws(
    () =>
      validateReviewedLayout(recipe, exactPreflight, {
        width: 2622,
        height: 1206,
        orientation: 'landscape',
      }),
    (error) => error instanceof RecordingError && error.code === 'reviewed_layout_mismatch',
  );

  const dir = tempDir(t, 'simulator-record-layout-gate-');
  let recorderStarts = 0;
  await assert.rejects(
    () =>
      recordRecipe(
        catalog,
        recipeFile,
        {
          recipe: recipe.id,
          udid: UDID,
          confirmVipSession: true,
          video: path.join(dir, 'raw.mp4'),
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        {
          routeOpener: passedRouteOpener,
          preflight: () => exactPreflight,
          runner: {
            async prepare() {},
            async preflightTarget() {
              return { status: 'verified_by_maestro_before_recording' };
            },
          },
          layoutProbe: async () => ({ width: 1179, height: 2556, orientation: 'portrait' }),
          videoRecorder: {
            async start() {
              recorderStarts += 1;
            },
          },
        },
      ),
    (error) => error instanceof RecordingError && error.code === 'reviewed_layout_mismatch',
  );
  assert.equal(recorderStarts, 0);
  assert.equal(fs.existsSync(path.join(dir, 'raw.mp4')), false);
});

test('三個 staged artifacts 發布中途失敗會 rollback 所有 final paths', (t) => {
  const dir = tempDir(t, 'simulator-record-atomic-publish-');
  const staged = {
    video: path.join(dir, 'stage-raw.mp4'),
    actions: path.join(dir, 'stage-actions.json'),
    manifest: path.join(dir, 'stage-manifest.json'),
  };
  const destinations = {
    video: path.join(dir, 'raw.mp4'),
    actions: path.join(dir, 'actions.json'),
    manifest: path.join(dir, 'manifest.json'),
  };
  Object.values(staged).forEach((filePath) => fs.writeFileSync(filePath, 'staged'));
  let links = 0;
  assert.throws(
    () =>
      publishArtifactsAtomically(staged, destinations, {
        linkSync(source, destination) {
          links += 1;
          if (links === 2) throw new Error('injected second-link failure');
          fs.linkSync(source, destination);
        },
        unlinkSync: fs.unlinkSync.bind(fs),
      }),
    (error) => error instanceof RecordingError && error.code === 'artifact_publish_failed',
  );
  assert.deepEqual(Object.values(destinations).map((filePath) => fs.existsSync(filePath)), [
    false,
    false,
    false,
  ]);
});

test('simctl finalize 有界升級 SIGINT→SIGTERM→SIGKILL，並拒絕 forced、timeout、bad exit/stderr', async () => {
  async function exercise(onKill, stderrText = '') {
    const signals = [];
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      signals.push(signal);
      onKill?.(child, signal);
      return true;
    };
    const recorder = createSimctlVideoRecorder({
      sigintTimeoutMs: 2,
      sigtermTimeoutMs: 2,
      sigkillTimeoutMs: 2,
      spawn() {
        queueMicrotask(() => {
          child.emit('spawn');
          if (stderrText) child.stderr.emit('data', stderrText);
        });
        return child;
      },
    });
    const handle = await recorder.start({ udid: UDID, videoPath: '/tmp/staged.mp4' });
    return { signals, stop: () => handle.stop() };
  }

  const forced = await exercise((child, signal) => {
    if (signal === 'SIGTERM') queueMicrotask(() => child.emit('close', 0, signal));
  });
  await assert.rejects(
    forced.stop,
    (error) => error instanceof RecordingError && error.code === 'video_finalize_forced',
  );
  assert.deepEqual(forced.signals, ['SIGINT', 'SIGTERM']);

  const timeout = await exercise(() => {});
  await assert.rejects(
    timeout.stop,
    (error) => error instanceof RecordingError && error.code === 'video_reap_timeout',
  );
  assert.deepEqual(timeout.signals, ['SIGINT', 'SIGTERM', 'SIGKILL']);

  const badExit = await exercise((child, signal) =>
    queueMicrotask(() => child.emit('close', 2, signal)),
  );
  await assert.rejects(
    badExit.stop,
    (error) => error instanceof RecordingError && error.code === 'video_finalize_bad_exit',
  );

  const badStderr = await exercise(
    (child, signal) => queueMicrotask(() => child.emit('close', 0, signal)),
    'Error: encoder failed',
  );
  await assert.rejects(
    badStderr.stop,
    (error) => error instanceof RecordingError && error.code === 'video_finalize_stderr',
  );
});

test('recorder finalize 失敗時 staged raw 會清除，final 三檔皆不存在', async (t) => {
  const { catalog, recipeFile } = setup();
  const dir = tempDir(t, 'simulator-record-finalize-no-publish-');
  await assert.rejects(
    () =>
      recordRecipe(
        catalog,
        recipeFile,
        {
          recipe: 'renbao.kline-main-force-swipe',
          udid: UDID,
          confirmVipSession: true,
          video: path.join(dir, 'raw.mp4'),
          actions: path.join(dir, 'actions.json'),
          manifest: path.join(dir, 'manifest.json'),
        },
        {
          routeOpener: passedRouteOpener,
          preflight: () => ({
            bundle: {},
            device: { name: 'iPhone 17 Pro', runtime: 'iOS-26-5' },
          }),
          layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
          runner: {
            async prepare() {},
            async preflightTarget() {
              return { status: 'verified_by_maestro_before_recording' };
            },
            async run() {
              return { observedEvents: [], runner: { name: 'mock', version: '1' } };
            },
          },
          videoRecorder: {
            async start({ videoPath }) {
              fs.writeFileSync(videoPath, 'staged-video');
              return {
                startedAtMs: 1000,
                async stop() {
                  throw new RecordingError('bad exit', 'video_finalize_bad_exit');
                },
              };
            },
          },
        },
      ),
    (error) =>
      error instanceof RecordingError &&
      error.code === 'video_finalize_failed' &&
      error.details.causeCode === 'video_finalize_bad_exit',
  );
  assert.deepEqual(['raw.mp4', 'actions.json', 'manifest.json'].map((name) => fs.existsSync(path.join(dir, name))), [
    false,
    false,
    false,
  ]);
});

test('event 超出 ffprobe timeline 或 raw 不在 10–15 秒時失敗且不發布 final artifacts', async (t) => {
  const { catalog, recipeFile } = setup();
  for (const scenario of ['event-past-video', 'duration-short']) {
    const dir = tempDir(t, `simulator-record-${scenario}-`);
    await assert.rejects(
      () =>
        recordRecipe(
          catalog,
          recipeFile,
          {
            recipe: 'renbao.kline-main-force-swipe',
            udid: UDID,
            confirmVipSession: true,
            video: path.join(dir, 'raw.mp4'),
            actions: path.join(dir, 'actions.json'),
            manifest: path.join(dir, 'manifest.json'),
          },
          {
            routeOpener: passedRouteOpener,
            preflight: () => ({
              bundle: {},
              device: { name: 'iPhone 17 Pro', runtime: 'iOS-26-5' },
            }),
            layoutProbe: async () => ({ width: 1206, height: 2622, orientation: 'portrait' }),
            runner: {
              async prepare() {},
              async preflightTarget() {
                return { status: 'verified_by_maestro_before_recording' };
              },
              async run() {
                return {
                  runner: { name: 'mock', version: '1' },
                  observedEvents: [
                    {
                      id: 'tap-bottom-main-force',
                      status: 'passed',
                      startedAtMs: 101000,
                      completedAtMs: 114000,
                      timingSource: 'mock',
                      precision: 'mock',
                    },
                  ],
                };
              },
            },
            videoRecorder: {
              async start({ videoPath }) {
                fs.writeFileSync(videoPath, 'staged-video');
                return {
                  startedAtMs: 100000,
                  async stop() {
                    return { stopRequestedAtMs: 112000, stoppedAtMs: 115000 };
                  },
                };
              },
            },
            probeVideo: async () => ({
              codec: 'h264',
              durationSeconds: scenario === 'duration-short' ? 9 : 12,
              width: 1206,
              height: 2622,
            }),
          },
        ),
      (error) =>
        error instanceof RecordingError &&
        error.code ===
          (scenario === 'duration-short'
            ? 'recording_duration_out_of_range'
            : 'event_outside_video_timeline'),
    );
    assert.deepEqual(['raw.mp4', 'actions.json', 'manifest.json'].map((name) => fs.existsSync(path.join(dir, name))), [
      false,
      false,
      false,
    ]);
  }
});
