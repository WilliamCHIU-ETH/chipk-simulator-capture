#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const {
  CliError,
  buildPlan,
  exactSimulator,
  getSourceVersion,
  readCatalog,
} = require('./simulator-capture');

const RECIPES_PATH = path.join(__dirname, '..', 'config', 'simulator-recording-recipes.json');
const UDID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const SAFE_ACTION_TYPES = new Set(['readiness', 'tap', 'swipe', 'assert', 'hold']);
const RECIPE_PROFILES = Object.freeze({
  STRICT_KLINE_INTERACTION: 'strict_kline_interaction',
  DIAGNOSTIC_TAB_SWITCH_BENCHMARK: 'diagnostic_tab_switch_benchmark',
});
const VIDEO_TIMELINE_TOLERANCE_MS = 1000;
const MAESTRO_ENV = Object.freeze({
  DEVELOPER_DIR: '/Applications/Xcode.app/Contents/Developer',
  MAESTRO_CLI_NO_ANALYTICS: '1',
  MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED: 'true',
});

class RecordingError extends Error {
  constructor(message, code = 'invalid_recording_request', details = undefined) {
    super(message);
    this.name = 'RecordingError';
    this.code = code;
    this.details = details;
  }
}

function readJson(filePath, missingCode, invalidCode) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new RecordingError(`找不到 JSON：${filePath}`, missingCode);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new RecordingError(`JSON 格式錯誤：${filePath}（${error.message}）`, invalidCode);
  }
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function recipeHash(recipe) {
  return sha256Buffer(Buffer.from(JSON.stringify(recipe), 'utf8'));
}

function rejectUnknownKeys(value, allowed, label, errors) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`${label} 必須是 object`);
    return;
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label} 不允許欄位：${key}`);
  }
}

function expectString(value, label, errors) {
  if (typeof value !== 'string' || value.trim() === '') errors.push(`${label} 必須是非空字串`);
}

function expectStringArray(value, label, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} 必須是非空字串陣列`);
    return;
  }
  value.forEach((item, index) => expectString(item, `${label}[${index}]`, errors));
}

function validateNormalizedPoint(value, label, errors, extraKeys = []) {
  rejectUnknownKeys(value, new Set(['x', 'y', ...extraKeys]), label, errors);
  if (!value || typeof value !== 'object') return;
  for (const axis of ['x', 'y']) {
    if (!Number.isFinite(value[axis]) || value[axis] < 0 || value[axis] > 1) {
      errors.push(`${label}.${axis} 必須介於 0 與 1`);
    }
  }
}

function validateZoomFocus(value, label, errors) {
  rejectUnknownKeys(value, new Set(['x', 'y', 'width', 'height']), label, errors);
  if (!value || typeof value !== 'object') return;
  for (const key of ['x', 'y', 'width', 'height']) {
    if (!Number.isFinite(value[key]) || value[key] < 0 || value[key] > 1) {
      errors.push(`${label}.${key} 必須介於 0 與 1`);
    }
  }
  if (Number.isFinite(value.x) && Number.isFinite(value.width) && value.x + value.width > 1) {
    errors.push(`${label} 超出水平 normalized 邊界`);
  }
  if (Number.isFinite(value.y) && Number.isFinite(value.height) && value.y + value.height > 1) {
    errors.push(`${label} 超出垂直 normalized 邊界`);
  }
}

function validateSelector(value, label, errors) {
  rejectUnknownKeys(value, new Set(['kind', 'value']), label, errors);
  if (!value || typeof value !== 'object') return;
  if (!['text', 'id'].includes(value.kind)) errors.push(`${label}.kind 只能是 text 或 id`);
  expectString(value.value, `${label}.value`, errors);
  if (typeof value.value === 'string' && /[\r\n\0]/.test(value.value)) {
    errors.push(`${label}.value 不得含控制換行`);
  }
}

function validateDuration(value, label, errors, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    errors.push(`${label} 必須是 ${min}..${max} 的整數毫秒`);
  }
}

function validateAction(action, label, errors) {
  const common = new Set(['id', 'type', 'zoomFocus']);
  const allowedByType = {
    readiness: new Set([...common, 'selectors', 'timeoutMs']),
    tap: new Set([...common, 'execution', 'touchPoint', 'waitToSettleTimeoutMs']),
    swipe: new Set([
      ...common,
      'start',
      'end',
      'durationMs',
      'waitToSettleTimeoutMs',
      'touchPath',
    ]),
    assert: new Set([...common, 'selectors', 'absentSelectors', 'timeoutMs']),
    hold: new Set([...common, 'durationMs']),
  };
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    errors.push(`${label} 必須是 object`);
    return;
  }
  expectString(action.id, `${label}.id`, errors);
  if (!SAFE_ID_RE.test(action.id || '')) errors.push(`${label}.id 格式不安全`);
  if (!SAFE_ACTION_TYPES.has(action.type)) {
    errors.push(`${label}.type 不允許：${String(action.type)}`);
    return;
  }
  rejectUnknownKeys(action, allowedByType[action.type], label, errors);
  if (action.zoomFocus !== undefined) validateZoomFocus(action.zoomFocus, `${label}.zoomFocus`, errors);

  if (action.type === 'readiness' || action.type === 'assert') {
    if (!Array.isArray(action.selectors) || action.selectors.length === 0) {
      errors.push(`${label}.selectors 必須是非空陣列`);
    } else {
      action.selectors.forEach((selector, index) =>
        validateSelector(selector, `${label}.selectors[${index}]`, errors),
      );
    }
    if (action.absentSelectors !== undefined) {
      if (!Array.isArray(action.absentSelectors) || action.absentSelectors.length === 0) {
        errors.push(`${label}.absentSelectors 必須是非空陣列`);
      } else {
        action.absentSelectors.forEach((selector, index) =>
          validateSelector(selector, `${label}.absentSelectors[${index}]`, errors),
        );
      }
    }
    validateDuration(action.timeoutMs, `${label}.timeoutMs`, errors, 1000, 120000);
  }

  if (action.type === 'tap') {
    rejectUnknownKeys(
      action.execution,
      new Set(['strategy', 'point', 'longPress', 'reviewedLayout']),
      `${label}.execution`,
      errors,
    );
    if (action.execution?.strategy !== 'reviewed_coordinate') {
      errors.push(`${label}.execution.strategy 必須是 reviewed_coordinate`);
    }
    if (
      action.execution?.longPress !== undefined &&
      typeof action.execution.longPress !== 'boolean'
    ) {
      errors.push(`${label}.execution.longPress 必須是 boolean`);
    }
    validateNormalizedPoint(action.execution?.point, `${label}.execution.point`, errors);
    rejectUnknownKeys(
      action.execution?.reviewedLayout,
      new Set([
        'deviceName',
        'runtime',
        'orientation',
        'screenshotWidth',
        'screenshotHeight',
        'interactionWidth',
        'interactionHeight',
      ]),
      `${label}.execution.reviewedLayout`,
      errors,
    );
    expectString(
      action.execution?.reviewedLayout?.deviceName,
      `${label}.execution.reviewedLayout.deviceName`,
      errors,
    );
    expectString(
      action.execution?.reviewedLayout?.runtime,
      `${label}.execution.reviewedLayout.runtime`,
      errors,
    );
    if (action.execution?.reviewedLayout?.orientation !== 'portrait') {
      errors.push(`${label}.execution.reviewedLayout.orientation 必須是 portrait`);
    }
    for (const dimension of [
      'screenshotWidth',
      'screenshotHeight',
      'interactionWidth',
      'interactionHeight',
    ]) {
      if (
        !Number.isInteger(action.execution?.reviewedLayout?.[dimension]) ||
        action.execution.reviewedLayout[dimension] <= 0
      ) {
        errors.push(`${label}.execution.reviewedLayout.${dimension} 必須是正整數`);
      }
    }
    const reviewedLayout = action.execution?.reviewedLayout;
    if (
      reviewedLayout &&
      Number.isInteger(reviewedLayout.screenshotWidth) &&
      Number.isInteger(reviewedLayout.screenshotHeight) &&
      Number.isInteger(reviewedLayout.interactionWidth) &&
      Number.isInteger(reviewedLayout.interactionHeight) &&
      (reviewedLayout.screenshotWidth / reviewedLayout.interactionWidth !==
        reviewedLayout.screenshotHeight / reviewedLayout.interactionHeight ||
        reviewedLayout.screenshotWidth / reviewedLayout.interactionWidth <= 1)
    ) {
      errors.push(
        `${label}.execution.reviewedLayout screenshot/interaction scale 必須一致且 screenshot 較大`,
      );
    }
    validateNormalizedPoint(action.touchPoint, `${label}.touchPoint`, errors);
    if (
      action.execution?.point &&
      action.touchPoint &&
      (action.execution.point.x !== action.touchPoint.x ||
        action.execution.point.y !== action.touchPoint.y)
    ) {
      errors.push(`${label}.touchPoint 必須與 execution.point 一致`);
    }
    validateDuration(
      action.waitToSettleTimeoutMs,
      `${label}.waitToSettleTimeoutMs`,
      errors,
      0,
      30000,
    );
  }

  if (action.type === 'swipe') {
    validateNormalizedPoint(action.start, `${label}.start`, errors);
    validateNormalizedPoint(action.end, `${label}.end`, errors);
    validateDuration(action.durationMs, `${label}.durationMs`, errors, 100, 5000);
    validateDuration(
      action.waitToSettleTimeoutMs,
      `${label}.waitToSettleTimeoutMs`,
      errors,
      0,
      30000,
    );
    rejectUnknownKeys(action.touchPath, new Set(['start', 'end']), `${label}.touchPath`, errors);
    if (action.touchPath && typeof action.touchPath === 'object') {
      validateNormalizedPoint(action.touchPath.start, `${label}.touchPath.start`, errors);
      validateNormalizedPoint(action.touchPath.end, `${label}.touchPath.end`, errors);
    }
  }

  if (action.type === 'hold') {
    validateDuration(action.durationMs, `${label}.durationMs`, errors, 250, 10000);
  }
}

function validateRecipes(recipeFile, catalog) {
  const errors = [];
  rejectUnknownKeys(recipeFile, new Set(['schemaVersion', 'recipes']), 'recipe file', errors);
  if (recipeFile?.schemaVersion !== 1) errors.push('recipe file schemaVersion 必須是 1');
  if (!Array.isArray(recipeFile?.recipes) || recipeFile.recipes.length === 0) {
    errors.push('recipes 必須是非空陣列');
  }
  const ids = new Set();
  for (const [index, recipe] of (recipeFile?.recipes || []).entries()) {
    const label = `recipes[${index}]`;
    rejectUnknownKeys(
      recipe,
      new Set([
        'id',
        'version',
        'profile',
        'mode',
        'routeId',
        'stock',
        'recordingDuration',
        'material',
        'actions',
      ]),
      label,
      errors,
    );
    if (!recipe || typeof recipe !== 'object') continue;
    expectString(recipe.id, `${label}.id`, errors);
    if (!SAFE_ID_RE.test(recipe.id || '')) errors.push(`${label}.id 格式不安全`);
    if (ids.has(recipe.id)) errors.push(`recipe id 重複：${recipe.id}`);
    ids.add(recipe.id);
    if (!Number.isInteger(recipe.version) || recipe.version < 1) {
      errors.push(`${label}.version 必須是正整數`);
    }
    if (!Object.values(RECIPE_PROFILES).includes(recipe.profile)) {
      errors.push(`${label}.profile 不支援：${String(recipe.profile)}`);
    }
    if (recipe.mode !== 'test') errors.push(`${label}.mode v1 只能是 test`);
    expectString(recipe.routeId, `${label}.routeId`, errors);
    const route = (catalog.routes || []).find((item) => item.id === recipe.routeId);
    if (!route) {
      errors.push(`${label}.routeId 不在 catalog：${recipe.routeId}`);
    } else {
      if (route.captureAllowed !== true) errors.push(`${label}.route 不允許 capture`);
      if (route.sideEffectRisk !== 'none') errors.push(`${label}.route sideEffectRisk 必須是 none`);
    }
    rejectUnknownKeys(recipe.stock, new Set(['id', 'name']), `${label}.stock`, errors);
    expectString(recipe.stock?.id, `${label}.stock.id`, errors);
    expectString(recipe.stock?.name, `${label}.stock.name`, errors);
    rejectUnknownKeys(
      recipe.recordingDuration,
      new Set(['targetMs', 'minMs', 'maxMs']),
      `${label}.recordingDuration`,
      errors,
    );
    const durationUpperBound =
      recipe.profile === RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK ? 60000 : 30000;
    for (const key of ['targetMs', 'minMs', 'maxMs']) {
      validateDuration(
        recipe.recordingDuration?.[key],
        `${label}.recordingDuration.${key}`,
        errors,
        1000,
        durationUpperBound,
      );
    }
    if (
      Number.isFinite(recipe.recordingDuration?.minMs) &&
      Number.isFinite(recipe.recordingDuration?.targetMs) &&
      Number.isFinite(recipe.recordingDuration?.maxMs) &&
      !(
        recipe.recordingDuration.minMs <= recipe.recordingDuration.targetMs &&
        recipe.recordingDuration.targetMs <= recipe.recordingDuration.maxMs
      )
    ) {
      errors.push(`${label}.recordingDuration 必須滿足 minMs <= targetMs <= maxMs`);
    }
    rejectUnknownKeys(
      recipe.material,
      new Set(['purpose', 'supportsCopy', 'doesNotProve']),
      `${label}.material`,
      errors,
    );
    expectString(recipe.material?.purpose, `${label}.material.purpose`, errors);
    expectStringArray(recipe.material?.supportsCopy, `${label}.material.supportsCopy`, errors);
    expectStringArray(recipe.material?.doesNotProve, `${label}.material.doesNotProve`, errors);
    if (!Array.isArray(recipe.actions) || recipe.actions.length === 0) {
      errors.push(`${label}.actions 必須是非空陣列`);
    } else {
      const actionIds = new Set();
      recipe.actions.forEach((action, actionIndex) => {
        validateAction(action, `${label}.actions[${actionIndex}]`, errors);
        if (actionIds.has(action?.id)) errors.push(`${label} action id 重複：${action.id}`);
        actionIds.add(action?.id);
      });
      if (recipe.actions[0]?.type !== 'readiness') errors.push(`${label} 第一個 action 必須是 readiness`);
      if (
        recipe.profile === RECIPE_PROFILES.STRICT_KLINE_INTERACTION &&
        recipe.actions.at(-1)?.type !== 'hold'
      ) {
        errors.push(`${label} strict recipe 最後一個 action 必須是 hold`);
      }
      const actionTypes = recipe.actions.map((action) => action.type);
      if (recipe.profile === RECIPE_PROFILES.STRICT_KLINE_INTERACTION) {
        for (const requiredType of ['tap', 'swipe', 'assert']) {
          if (!recipe.actions.some((action) => action.type === requiredType)) {
            errors.push(`${label} 缺少必要 ${requiredType} action`);
          }
        }
        if (
          recipe.actions.filter(
            (action) => action.type === 'tap' && action.execution?.longPress === true,
          ).length !== 1
        ) {
          errors.push(`${label} 必須恰有一個原生 long-press tap action`);
        }
        const tapLayouts = new Set(
          recipe.actions
            .filter((action) => action.type === 'tap')
            .map((action) => JSON.stringify(action.execution?.reviewedLayout)),
        );
        if (tapLayouts.size !== 1) {
          errors.push(`${label} 所有 tap action 必須共用同一 reviewedLayout`);
        }
        const chartLongPress = recipe.actions.find(
          (action) => action.type === 'tap' && action.execution?.longPress === true,
        );
        const chartSwipe = recipe.actions.find((action) => action.type === 'swipe');
        if (
          chartLongPress?.execution?.point &&
          chartSwipe?.start &&
          (chartLongPress.execution.point.x !== chartSwipe.start.x ||
            chartLongPress.execution.point.y !== chartSwipe.start.y)
        ) {
          errors.push(`${label} chart swipe 必須從 long-press point 開始`);
        }
      } else if (recipe.profile === RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK) {
        const taps = recipe.actions.filter((action) => action.type === 'tap');
        if (
          actionTypes.length !== 3 ||
          actionTypes[0] !== 'readiness' ||
          actionTypes[1] !== 'tap' ||
          actionTypes[2] !== 'assert'
        ) {
          errors.push(`${label} diagnostic benchmark actions 必須恰為 readiness → tap → assert`);
        }
        if (taps.length !== 1 || taps[0]?.execution?.longPress === true) {
          errors.push(`${label} diagnostic benchmark 必須恰有一個非 long-press tap`);
        }
        if (recipe.actions.some((action) => action.type === 'swipe')) {
          errors.push(`${label} diagnostic benchmark 不得含 swipe`);
        }
        if (recipe.actions.filter((action) => action.type === 'assert').length !== 1) {
          errors.push(`${label} diagnostic benchmark 必須恰有一個 result assert`);
        }
      }
    }
    if (route) {
      try {
        const plan = buildPlan(catalog, {
          route: recipe.routeId,
          mode: recipe.mode,
          stockId: recipe.stock?.id,
          stockName: recipe.stock?.name,
        });
        if (plan.parameters.stockid !== recipe.stock?.id) {
          errors.push(`${label}.stock.id 無法由 catalog deterministic 解析`);
        }
        if (plan.parameters.stockname !== recipe.stock?.name) {
          errors.push(`${label}.stock.name 無法由 catalog deterministic 解析`);
        }
      } catch (error) {
        errors.push(`${label} 無法建立 catalog plan：${error.message}`);
      }
    }
  }
  if (errors.length > 0) throw new RecordingError(errors.join('；'), 'recipes_invalid');
  return {
    ok: true,
    schemaVersion: 1,
    recipeCount: recipeFile.recipes.length,
    recipeIds: recipeFile.recipes.map((recipe) => recipe.id),
  };
}

function readRecipes(catalog, recipePath = RECIPES_PATH) {
  const recipeFile = readJson(recipePath, 'recipes_missing', 'recipes_invalid_json');
  validateRecipes(recipeFile, catalog);
  return recipeFile;
}

function getRecipe(recipeFile, recipeId) {
  if (!recipeId) throw new RecordingError('--recipe 為必要參數', 'missing_recipe');
  const recipe = recipeFile.recipes.find((item) => item.id === recipeId);
  if (!recipe) throw new RecordingError(`未知 recording recipe：${recipeId}`, 'unknown_recipe');
  return recipe;
}

function plannedEvents(recipe, routePlan) {
  return [
    {
      id: 'navigation.open-route',
      type: 'navigation',
      url: routePlan.url,
      timing: 'planned_only',
      phase: 'pre_record',
    },
    ...recipe.actions.map((action) => ({
      ...action,
      timing: 'planned_only',
      phase: action.type === 'readiness' ? 'pre_record' : 'in_record',
    })),
  ];
}

function planRecipe(catalog, recipeFile, recipeId) {
  const recipe = getRecipe(recipeFile, recipeId);
  const routePlan = buildPlan(catalog, {
    route: recipe.routeId,
    mode: recipe.mode,
    stockId: recipe.stock.id,
    stockName: recipe.stock.name,
  });
  return {
    dryRun: true,
    requestedScope: 'recording_plan_only',
    nextAction: 'stop_after_plan',
    recipe: {
      id: recipe.id,
      version: recipe.version,
      profile: recipe.profile,
      sha256: recipeHash(recipe),
    },
    mode: recipe.mode,
    route: routePlan.route,
    navigation: {
      url: routePlan.url,
      parameters: routePlan.parameters,
      expectedTexts: routePlan.expectedTexts,
      contentTexts: routePlan.contentTexts,
    },
    material: recipe.material,
    recordingDuration: recipe.recordingDuration,
    planned: plannedEvents(recipe, routePlan),
    timing: {
      semantics: 'planned actions have no observed timeline offsets',
      observationSource:
        recipe.profile === RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK
          ? 'simctl openurl process evidence for navigation; one Maestro commands.json run for readiness, recording boundaries, tap, and result assertions'
          : 'simctl openurl process evidence for navigation; Maestro commands.json/local clock for assertions and in-record actions',
    },
    captureGate: {
      authorization: 'required',
      exactUdid: 'required',
      persona: 'vip',
      vipSessionAttestation: 'human_required',
      targetSessionPreflight: 'machine_required_before_recording',
      outputs: ['raw.mp4', 'actions.json', 'recording-manifest.json'],
    },
  };
}

function defaultExec(file, args, options = {}) {
  return execFileSync(file, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function runRecordingPreflight(catalog, udid, deps = {}) {
  if (!UDID_RE.test(udid || '')) {
    throw new RecordingError('--udid 必須是完整 Simulator UDID', 'invalid_udid');
  }
  const exec = deps.exec || defaultExec;
  let devicesJson;
  try {
    devicesJson = JSON.parse(exec('xcrun', ['simctl', 'list', 'devices', '--json']));
  } catch (error) {
    throw new RecordingError(`無法讀取 Simulator 清單：${error.message}`, 'simctl_unavailable');
  }
  let device;
  try {
    device = exactSimulator(devicesJson, udid);
  } catch (error) {
    throw new RecordingError(error.message, error.code || 'simulator_not_found');
  }
  if (device.isAvailable === false) {
    throw new RecordingError(`Simulator ${udid} 不可用`, 'simulator_unavailable');
  }
  if (device.state !== 'Booted') {
    throw new RecordingError(`Simulator ${udid} 尚未 Booted`, 'simulator_not_booted');
  }
  let appPath;
  try {
    appPath = exec('xcrun', [
      'simctl',
      'get_app_container',
      udid,
      catalog.product.bundleId,
      'app',
    ]);
  } catch (error) {
    throw new RecordingError(
      `Simulator ${udid} 尚未安裝 ${catalog.product.bundleId}`,
      'app_not_installed',
    );
  }
  const infoPath = path.join(appPath, 'Info.plist');
  let version;
  let build;
  try {
    version = exec('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', infoPath]);
    build = exec('plutil', ['-extract', 'CFBundleVersion', 'raw', '-o', '-', infoPath]);
  } catch (error) {
    throw new RecordingError(`無法讀取 App 版本：${error.message}`, 'app_metadata_unavailable');
  }
  return {
    ok: true,
    udid,
    device: { name: device.name, state: device.state, runtime: device.runtime },
    bundle: { id: catalog.product.bundleId, version, build },
  };
}

function openRouteWithSimctl(udid, url, deps = {}) {
  if (!UDID_RE.test(udid || '')) {
    throw new RecordingError('--udid 必須是完整 Simulator UDID', 'invalid_udid');
  }
  if (typeof url !== 'string' || !url.startsWith('chipk://')) {
    throw new RecordingError('只允許開啟 catalog 解析後的 ChipK custom-scheme URL', 'route_url_invalid');
  }
  const exec = deps.exec || defaultExec;
  const clock = deps.clock || Date.now;
  const startedAtMs = clock();
  try {
    exec('xcrun', ['simctl', 'openurl', udid, url]);
  } catch (error) {
    throw new RecordingError(
      `無法在指定 Simulator 開啟錄影目標 route：${error.message}`,
      'route_open_failed',
      {
        source: 'xcrun_simctl_openurl_process',
        udid,
        url,
      },
    );
  }
  const completedAtMs = clock();
  return {
    id: 'navigation.open-route',
    status: 'passed',
    startedAtMs,
    completedAtMs,
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

function yamlString(value) {
  return JSON.stringify(String(value));
}

function selectorLines(selector, indent) {
  return [`${' '.repeat(indent)}${selector.kind}: ${yamlString(selector.value)}`];
}

function wrappedFlow(label, commands) {
  return [
    '- runFlow:',
    `    label: ${yamlString(`recording:${label}`)}`,
    '    commands:',
    ...commands.map((line) => `      ${line}`),
  ];
}

function waitAndAssertLines(action) {
  const lines = [];
  for (const selector of action.selectors) {
    lines.push('- extendedWaitUntil:', '    visible:');
    lines.push(...selectorLines(selector, 6));
    lines.push(`    timeout: ${action.timeoutMs}`);
    lines.push('- assertVisible:');
    lines.push(...selectorLines(selector, 4));
  }
  for (const selector of action.absentSelectors || []) {
    lines.push('- assertNotVisible:');
    lines.push(...selectorLines(selector, 4));
  }
  return lines;
}

function tapLines(action) {
  const { interactionWidth, interactionHeight } = action.execution.reviewedLayout;
  const point = `${Math.round(action.execution.point.x * interactionWidth)},${Math.round(
    action.execution.point.y * interactionHeight,
  )}`;
  const isLongPress = action.execution.longPress === true;
  return [
    isLongPress ? '- longPressOn:' : '- tapOn:',
    `    point: ${yamlString(point)}`,
    `    waitToSettleTimeoutMs: ${action.waitToSettleTimeoutMs}`,
    `    label: ${yamlString(
      isLongPress
        ? 'recording-target:reviewed-coordinate-long-press'
        : 'recording-target:reviewed-coordinate',
    )}`,
  ];
}

function swipeLines(action, reviewedLayout) {
  const { interactionWidth, interactionHeight } = reviewedLayout;
  const start = `${Math.round(action.start.x * interactionWidth)},${Math.round(
    action.start.y * interactionHeight,
  )}`;
  const end = `${Math.round(action.end.x * interactionWidth)},${Math.round(
    action.end.y * interactionHeight,
  )}`;
  return [
    '- swipe:',
    `    start: ${yamlString(start)}`,
    `    end: ${yamlString(end)}`,
    `    duration: ${action.durationMs}`,
    `    waitToSettleTimeoutMs: ${action.waitToSettleTimeoutMs}`,
    `    label: ${yamlString(`recording-gesture:${action.id}`)}`,
  ];
}

function buildMaestroPreparationFlow(recipe, _routePlan, bundleId) {
  const readiness = recipe.actions.find((action) => action.type === 'readiness');
  if (!readiness) {
    throw new RecordingError('recipe 缺少 pre-record readiness', 'missing_readiness');
  }
  const lines = [
    `appId: ${yamlString(bundleId)}`,
    `name: ${yamlString(`${recipe.id}-pre-record`)}`,
    '---',
    ...wrappedFlow('navigation.accept-chipk-open-confirmation', [
      '- tapOn:',
      `    text: ${yamlString('打開')}`,
      '    optional: true',
      '    waitToSettleTimeoutMs: 3000',
    ]),
    ...wrappedFlow(readiness.id, waitAndAssertLines(readiness)),
    ...wrappedFlow('session.login-absent', [
      '- assertNotVisible:',
      `    text: ${yamlString('使用 CMoney 帳號登入')}`,
    ]),
  ];
  return `${lines.join('\n')}\n`;
}

function buildMaestroFlow(recipe, _routePlan, bundleId, actionIds = null) {
  const lines = [
    `appId: ${yamlString(bundleId)}`,
    `name: ${yamlString(`${recipe.id}-interaction`)}`,
    '---',
  ];
  const reviewedLayout = recipe.actions.find((action) => action.type === 'tap')?.execution
    ?.reviewedLayout;
  const selectedIds = actionIds ? new Set(actionIds) : null;
  for (const action of recipe.actions) {
    if (action.type === 'readiness' || action.type === 'hold') continue;
    if (selectedIds && !selectedIds.has(action.id)) continue;
    let commands;
    if (action.type === 'assert') {
      commands = waitAndAssertLines(action);
    } else if (action.type === 'tap') {
      commands = tapLines(action);
    } else if (action.type === 'swipe') {
      commands = swipeLines(action, reviewedLayout);
    } else {
      throw new RecordingError(`無法編譯 action：${action.type}`, 'unsupported_action');
    }
    lines.push(...wrappedFlow(action.id, commands));
  }
  return `${lines.join('\n')}\n`;
}

const DIAGNOSTIC_RECORDING_STEM = 'start-recording/tab-switch-benchmark';
const DIAGNOSTIC_RECORDING_EVENT_IDS = Object.freeze({
  animation: 'recording.wait-for-animation',
});

function validateRelativeRecordingStem(value) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.endsWith('.mp4') ||
    path.isAbsolute(value) ||
    value.split(/[\\/]/).some((part) => part === '' || part === '.' || part === '..') ||
    !/^[a-z0-9][a-z0-9._/-]*$/i.test(value)
  ) {
    throw new RecordingError(
      'Maestro startRecording path 必須是安全的相對 stem（不含副檔名）',
      'recording_stem_invalid',
    );
  }
  return value;
}

function buildMaestroDiagnosticSingleFlow(
  recipe,
  _routePlan,
  bundleId,
  recordingStem = DIAGNOSTIC_RECORDING_STEM,
) {
  if (recipe.profile !== RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK) {
    throw new RecordingError('single-flow compiler 只允許 diagnostic profile', 'profile_mismatch');
  }
  const readiness = recipe.actions.find((action) => action.type === 'readiness');
  const tap = recipe.actions.find((action) => action.type === 'tap');
  const resultAssert = recipe.actions.find((action) => action.type === 'assert');
  if (!readiness || !tap || !resultAssert) {
    throw new RecordingError(
      'diagnostic recipe 缺少 readiness/tap/result assert',
      'diagnostic_actions_incomplete',
    );
  }
  const stem = validateRelativeRecordingStem(recordingStem);
  const { interactionWidth, interactionHeight } = tap.execution.reviewedLayout;
  const tapPoint = `${Math.round(tap.execution.point.x * interactionWidth)},${Math.round(
    tap.execution.point.y * interactionHeight,
  )}`;
  const lines = [
    `appId: ${yamlString(bundleId)}`,
    `name: ${yamlString(`${recipe.id}-single-flow`)}`,
    '---',
    ...waitAndAssertLines(readiness),
    '- assertNotVisible:',
    `    text: ${yamlString('使用 CMoney 帳號登入')}`,
    '- startRecording:',
    `    path: ${yamlString(stem)}`,
    '- tapOn:',
    `    point: ${yamlString(tapPoint)}`,
    `    waitToSettleTimeoutMs: ${tap.waitToSettleTimeoutMs}`,
    '- waitForAnimationToEnd:',
    '    timeout: 3000',
    ...waitAndAssertLines(resultAssert),
    '- stopRecording',
  ];
  return `${lines.join('\n')}\n`;
}

function createCommandRunner(spawnImpl = spawn) {
  let active = null;
  const interruptActive = () => {
    if (!active) return;
    active.child.kill('SIGINT');
    if (!active.forceTimer) {
      active.forceTimer = setTimeout(() => active?.child.kill('SIGKILL'), 5000);
    }
  };
  return {
    async run(file, args, options = {}) {
      if (active) throw new RecordingError('runner 同時只能執行一個 process', 'runner_busy');
      const timeoutMs = options.timeoutMs || 180000;
      return await new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const child = spawnImpl(file, args, {
          cwd: options.cwd,
          env: { ...process.env, ...(options.env || {}) },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        active = { child, forceTimer: null };
        const timer = setTimeout(() => {
          if (!settled) interruptActive();
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => {
          if (stdout.length < 65536) stdout += String(chunk).slice(0, 65536 - stdout.length);
        });
        child.stderr?.on('data', (chunk) => {
          if (stderr.length < 65536) stderr += String(chunk).slice(0, 65536 - stderr.length);
        });
        child.once('error', (error) => {
          settled = true;
          clearTimeout(timer);
          if (active?.forceTimer) clearTimeout(active.forceTimer);
          active = null;
          reject(error);
        });
        child.once('close', (code, signal) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (active?.forceTimer) clearTimeout(active.forceTimer);
          active = null;
          resolve({ code, signal, stdout, stderr });
        });
      });
    },
    cancel() {
      interruptActive();
    },
  };
}

function walkFiles(root) {
  const result = [];
  if (!fs.existsSync(root)) return result;
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name);
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) result.push(next);
    }
  };
  visit(root);
  return result;
}

function commandLabel(entry) {
  for (const base of [entry?.metadata?.evaluatedCommand, entry?.command]) {
    if (!base || typeof base !== 'object') continue;
    for (const value of Object.values(base)) {
      if (value && typeof value === 'object' && typeof value.label === 'string') {
        if (value.label.startsWith('recording:')) return value.label.slice('recording:'.length);
      }
    }
  }
  return null;
}

function containsKey(value, wanted) {
  if (!value || typeof value !== 'object') return false;
  if (Object.keys(value).some((key) => wanted.has(key))) return true;
  return Object.values(value).some((item) => containsKey(item, wanted));
}

function commandsPathsFromArtifacts(outputRoot) {
  const files = walkFiles(outputRoot);
  const paths = new Set();
  for (const manifestPath of files.filter((file) => path.basename(file) === 'manifest.json')) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
      continue;
    }
    for (const entry of manifest.entries || []) {
      if (entry.kind !== 'COMMAND_METADATA' || typeof entry.relativePath !== 'string') continue;
      const candidate = path.resolve(path.dirname(manifestPath), entry.relativePath);
      const relative = path.relative(path.resolve(outputRoot), candidate);
      if (!relative.startsWith('..') && !path.isAbsolute(relative) && fs.existsSync(candidate)) {
        paths.add(candidate);
      }
    }
  }
  if (paths.size === 0) {
    for (const file of files) {
      if (path.basename(file) === 'commands.json') paths.add(file);
    }
  }
  return [...paths];
}

function maestroCommandEntries(outputRoot) {
  const commandFiles = commandsPathsFromArtifacts(outputRoot);
  const records = [];
  for (const commandPath of commandFiles) {
    try {
      const value = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
      const entries = Array.isArray(value) ? value : value.commands;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) records.push({ commandPath, entry });
    } catch (_) {}
  }
  return { commandFiles, records };
}

function singleFlowCommandEntries(outputRoot) {
  const outputRootResolved = path.resolve(outputRoot);
  const commandFiles = new Set();
  for (const manifestPath of walkFiles(outputRoot).filter(
    (file) => path.basename(file) === 'manifest.json',
  )) {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (_) {
      continue;
    }
    for (const entry of manifest.entries || []) {
      if (entry.kind !== 'COMMAND_METADATA' || typeof entry.relativePath !== 'string') continue;
      const candidate = path.resolve(path.dirname(manifestPath), entry.relativePath);
      if (
        containedRelativePath(outputRootResolved, candidate) &&
        fs.existsSync(candidate)
      ) {
        commandFiles.add(candidate);
      }
    }
  }
  if (commandFiles.size !== 1) {
    throw new RecordingError(
      'diagnostic single-flow 必須由 manifest 解析出恰一份 COMMAND_METADATA',
      'runner_evidence_invalid',
      { commandMetadataFiles: commandFiles.size },
    );
  }
  const commandPath = [...commandFiles][0];
  let value;
  try {
    value = JSON.parse(fs.readFileSync(commandPath, 'utf8'));
  } catch (error) {
    throw new RecordingError(
      `diagnostic commands.json 無效：${error.message}`,
      'runner_evidence_invalid',
    );
  }
  const entries = Array.isArray(value) ? value : value.commands;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new RecordingError('diagnostic commands.json 沒有 command entries', 'runner_evidence_invalid');
  }
  return {
    commandFiles: [commandPath],
    records: entries.map((entry) => ({ commandPath, entry })),
  };
}

function commandContainsAnyKey(entry, keys) {
  return containsKey(entry?.metadata?.evaluatedCommand || entry?.command, new Set(keys));
}

function evaluatedMaestroCommand(record) {
  return record?.entry?.metadata?.evaluatedCommand || record?.entry?.command || {};
}

function assertionPredicate(selector, visibility) {
  return (record) => {
    const command = evaluatedMaestroCommand(record).assertConditionCommand;
    const condition = command?.condition?.[visibility];
    if (!condition) return false;
    if (selector.kind === 'text') return condition.textRegex === selector.value;
    if (selector.kind === 'id') return condition.idRegex === selector.value;
    return false;
  };
}

function pointPredicate(expectedPoint) {
  return (record) => {
    const command = evaluatedMaestroCommand(record);
    const tap = command.tapOnPointV2Command || command.tapOnPointCommand;
    if (!tap) return false;
    if (typeof tap.point === 'string') return tap.point === expectedPoint;
    return `${tap.point?.x},${tap.point?.y}` === expectedPoint;
  };
}

function animationWaitPredicate(record) {
  return commandContainsAnyKey(record.entry, [
    'waitForAnimationToEndCommand',
    'waitForAnimationCommand',
  ]);
}

function observedEventFromRecords(id, records) {
  const timestamps = records.map((record) => record.entry?.metadata?.timestamp);
  const completions = records.map(
    (record) => record.entry?.metadata?.timestamp + record.entry?.metadata?.duration,
  );
  if (
    records.length === 0 ||
    timestamps.some((value) => !Number.isFinite(value)) ||
    completions.some((value) => !Number.isFinite(value))
  ) {
    throw new RecordingError(`Maestro semantic event 缺少 timing：${id}`, 'runner_evidence_invalid');
  }
  return {
    id,
    status: 'passed',
    startedAtMs: Math.min(...timestamps),
    completedAtMs: Math.max(...completions),
    timingSource: 'maestro_commands_json_semantic_signature',
    precision: 'command_metadata_not_touch_frame_exact',
  };
}

function normalizedTimeout(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : Number.NaN;
}

function assertionSpec(selector, visibility, timeoutMs, eventId, errorCode) {
  return {
    eventId,
    errorCode,
    description: `${visibility}:${selector.value}:timeout=${timeoutMs ?? 'none'}`,
    predicate(record) {
      const command = evaluatedMaestroCommand(record).assertConditionCommand;
      return (
        assertionPredicate(selector, visibility)(record) &&
        normalizedTimeout(command?.timeout) === normalizedTimeout(timeoutMs)
      );
    },
  };
}

function mapDiagnosticSingleFlowEvents(records, recipe) {
  const readiness = recipe.actions.find((action) => action.type === 'readiness');
  const tap = recipe.actions.find((action) => action.type === 'tap');
  const resultAssert = recipe.actions.find((action) => action.type === 'assert');
  const preamble = [
    { key: 'defineVariablesCommand', description: 'defineVariablesCommand' },
    { key: 'applyConfigurationCommand', description: 'applyConfigurationCommand' },
  ];
  if (records.length < preamble.length) {
    throw new RecordingError('Maestro diagnostic command sequence 缺少 preamble', 'runner_evidence_invalid');
  }
  for (const [index, expected] of preamble.entries()) {
    const record = records[index];
    if (
      !commandContainsAnyKey(record.entry, [expected.key]) ||
      record.entry?.metadata?.status !== 'COMPLETED'
    ) {
      throw new RecordingError(
        `Maestro diagnostic preamble[${index}] 必須是 completed ${expected.description}`,
        'runner_evidence_invalid',
      );
    }
  }

  const leafRecords = records.slice(preamble.length);

  const specs = [];
  for (const selector of readiness.selectors) {
    specs.push(
      assertionSpec(selector, 'visible', readiness.timeoutMs, readiness.id, 'session_preflight_failed'),
      assertionSpec(selector, 'visible', null, readiness.id, 'session_preflight_failed'),
    );
  }
  specs.push(
    assertionSpec(
      { kind: 'text', value: '使用 CMoney 帳號登入' },
      'notVisible',
      null,
      'session.login-absent',
      'session_preflight_failed',
    ),
    {
      eventId: null,
      errorCode: 'maestro_recording_start_failed',
      description: `startRecording:${DIAGNOSTIC_RECORDING_STEM}`,
      predicate(record) {
        const command = evaluatedMaestroCommand(record);
        const start = command.startRecordingCommand || command.startScreenRecordingCommand;
        return start?.path === DIAGNOSTIC_RECORDING_STEM;
      },
    },
  );
  const { interactionWidth, interactionHeight } = tap.execution.reviewedLayout;
  const tapPoint = `${Math.round(tap.execution.point.x * interactionWidth)},${Math.round(
    tap.execution.point.y * interactionHeight,
  )}`;
  specs.push(
    {
      eventId: tap.id,
      errorCode: 'runner_failed',
      description: `tap:${tapPoint}`,
      predicate: pointPredicate(tapPoint),
    },
    {
      eventId: DIAGNOSTIC_RECORDING_EVENT_IDS.animation,
      errorCode: 'runner_failed',
      description: 'waitForAnimationToEnd:timeout=3000',
      predicate(record) {
        const command = evaluatedMaestroCommand(record);
        const wait = command.waitForAnimationToEndCommand || command.waitForAnimationCommand;
        return Boolean(wait) && normalizedTimeout(wait.timeout) === 3000;
      },
    },
  );
  for (const selector of resultAssert.selectors) {
    specs.push(
      assertionSpec(
        selector,
        'visible',
        resultAssert.timeoutMs,
        resultAssert.id,
        'runner_failed',
      ),
      assertionSpec(selector, 'visible', null, resultAssert.id, 'runner_failed'),
    );
  }
  for (const selector of resultAssert.absentSelectors || []) {
    specs.push(assertionSpec(selector, 'notVisible', null, resultAssert.id, 'runner_failed'));
  }
  specs.push({
    eventId: null,
    errorCode: 'maestro_recording_stop_failed',
    description: 'stopRecording',
    predicate(record) {
      return commandContainsAnyKey(record.entry, [
        'stopRecordingCommand',
        'stopScreenRecordingCommand',
      ]);
    },
  });

  if (leafRecords.length !== specs.length) {
    throw new RecordingError(
      'Maestro diagnostic leaf command 數量與 compiled recipe 不符',
      'runner_evidence_invalid',
      { expectedCount: specs.length, actualCount: leafRecords.length },
    );
  }
  const byEvent = new Map();
  for (const [index, spec] of specs.entries()) {
    const record = leafRecords[index];
    if (!spec.predicate(record)) {
      throw new RecordingError(
        `Maestro diagnostic leaf[${index}] semantic/reorder mismatch：${spec.description}`,
        spec.errorCode,
      );
    }
    if (record.entry?.metadata?.status !== 'COMPLETED') {
      throw new RecordingError(
        `Maestro diagnostic leaf[${index}] 未完成：${spec.description}`,
        spec.errorCode,
        { status: record.entry?.metadata?.status || null },
      );
    }
    if (spec.eventId) {
      const grouped = byEvent.get(spec.eventId) || [];
      grouped.push(record);
      byEvent.set(spec.eventId, grouped);
    }
  }
  const event = (id) => observedEventFromRecords(id, byEvent.get(id) || []);
  return {
    preRecordEvents: [event(readiness.id), event('session.login-absent')],
    inRecordEvents: [
      event(tap.id),
      event(DIAGNOSTIC_RECORDING_EVENT_IDS.animation),
      event(resultAssert.id),
    ],
    expectedPreRecordEventIds: [readiness.id, 'session.login-absent'],
  };
}

function typedArtifacts(value, result = [], seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return result;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) typedArtifacts(item, result, seen);
    return result;
  }
  const type = value.type || value.kind;
  const artifactPath = value.path || value.relativePath;
  if (typeof type === 'string' && typeof artifactPath === 'string') {
    result.push({ type, path: artifactPath });
  }
  for (const child of Object.values(value)) typedArtifacts(child, result, seen);
  return result;
}

function containedRelativePath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function resolveMaestroArtifactPath(outputRoot, commandPath, artifactPath) {
  if (
    typeof artifactPath !== 'string' ||
    artifactPath.length === 0 ||
    artifactPath.includes('\0') ||
    path.isAbsolute(artifactPath)
  ) {
    throw new RecordingError('Maestro video artifact path 不安全', 'video_artifact_path_invalid');
  }
  const runRoot = path.resolve(path.dirname(commandPath));
  const outputRootResolved = path.resolve(outputRoot);
  const candidate = path.resolve(runRoot, artifactPath);
  if (
    !containedRelativePath(runRoot, candidate) ||
    !containedRelativePath(outputRootResolved, candidate)
  ) {
    throw new RecordingError(
      'Maestro video artifact path 嘗試離開 test output root',
      'video_artifact_path_traversal',
    );
  }
  if (!candidate.toLowerCase().endsWith('.mp4')) {
    throw new RecordingError('Maestro recording artifact 不是 MP4', 'video_artifact_invalid');
  }
  if (!fs.existsSync(candidate)) {
    throw new RecordingError('Maestro startRecording MP4 不存在', 'video_missing');
  }
  const outputReal = fs.realpathSync(outputRootResolved);
  const candidateReal = fs.realpathSync(candidate);
  if (!containedRelativePath(outputReal, candidateReal)) {
    throw new RecordingError(
      'Maestro video artifact symlink 離開 test output root',
      'video_artifact_path_traversal',
    );
  }
  const stat = fs.statSync(candidateReal);
  if (!stat.isFile() || stat.size <= 0) {
    throw new RecordingError('Maestro startRecording MP4 無效或為空', 'video_missing');
  }
  return candidateReal;
}

function findRecordingBoundary(records, type, commandKeys) {
  const candidates = records.filter(({ entry }) => commandContainsAnyKey(entry, commandKeys));
  if (candidates.length === 0) {
    throw new RecordingError(
      `Maestro command metadata 缺少 ${type}Recording`,
      `maestro_recording_${type}_missing`,
    );
  }
  const completed = candidates.filter(({ entry }) => entry?.metadata?.status === 'COMPLETED');
  if (completed.length !== 1) {
    throw new RecordingError(
      `Maestro ${type}Recording 未成功或不唯一`,
      `maestro_recording_${type}_failed`,
      { statuses: candidates.map(({ entry }) => entry?.metadata?.status || null) },
    );
  }
  const selected = completed[0];
  const timestamp = selected.entry?.metadata?.timestamp;
  const duration = selected.entry?.metadata?.duration;
  if (!Number.isFinite(timestamp) || !Number.isFinite(duration) || duration < 0) {
    throw new RecordingError(
      `Maestro ${type}Recording 缺少有效 timing`,
      `maestro_recording_${type}_failed`,
    );
  }
  return { ...selected, timestamp, duration };
}

function resolveMaestroSingleFlowRecording(outputRoot, evidence = null) {
  evidence = evidence || singleFlowCommandEntries(outputRoot);
  const { commandFiles, records } = evidence;
  const start = findRecordingBoundary(records, 'start', [
    'startRecordingCommand',
    'startScreenRecordingCommand',
  ]);
  const stop = findRecordingBoundary(records, 'stop', [
    'stopRecordingCommand',
    'stopScreenRecordingCommand',
  ]);
  const recordingStartedAtMs = start.timestamp + start.duration;
  const stopRequestedAtMs = stop.timestamp;
  const recordingStoppedAtMs = stop.timestamp + stop.duration;
  if (stopRequestedAtMs < recordingStartedAtMs) {
    throw new RecordingError(
      'Maestro stopRecording 發生在 startRecording 完成前',
      'maestro_recording_boundary_invalid',
    );
  }
  const artifacts = typedArtifacts(start.entry).filter(
    (artifact) => artifact.type === 'START_SCREEN_RECORDING',
  );
  if (artifacts.length !== 1) {
    throw new RecordingError(
      '成功的 startRecording command metadata 必須恰有一個 START_SCREEN_RECORDING artifact',
      artifacts.length === 0 ? 'maestro_recording_artifact_missing' : 'maestro_recording_artifact_ambiguous',
    );
  }
  const videoPath = resolveMaestroArtifactPath(outputRoot, start.commandPath, artifacts[0].path);
  return {
    videoPath,
    recordingStartedAtMs,
    stopRequestedAtMs,
    recordingStoppedAtMs,
    commandMetadataFiles: commandFiles.length,
    commandEntryCount: records.length,
    boundarySemantics: {
      start: 'successful_startRecording_command_completion',
      stopRequest: 'successful_stopRecording_command_start',
      stopComplete: 'successful_stopRecording_command_completion',
    },
  };
}

function stageMaestroVideo(sourcePath, destinationPath, fsImpl = fs) {
  if (fsImpl.existsSync(destinationPath)) {
    throw new RecordingError('staged raw video 已存在', 'staged_video_exists');
  }
  try {
    fsImpl.linkSync(sourcePath, destinationPath);
    return 'hard_link';
  } catch (linkError) {
    try {
      fsImpl.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      return 'exclusive_copy';
    } catch (copyError) {
      throw new RecordingError(
        `無法 stage Maestro recording artifact：${copyError.message}`,
        'video_stage_failed',
        { linkError: linkError.code || linkError.message },
      );
    }
  }
}

function parseMaestroTimings(outputRoot, eventIds, recordingAnchorMs) {
  const { commandFiles, records } = maestroCommandEntries(outputRoot);
  const entries = records.map(({ entry }) => entry);
  const observed = [];
  for (const eventId of eventIds) {
    const candidates = entries.filter((entry) => commandLabel(entry) === eventId);
    const timed = candidates
      .map((entry) => ({ entry, metadata: entry.metadata || {} }))
      .filter(
        ({ metadata }) =>
          Number.isFinite(metadata.timestamp) &&
          Number.isFinite(metadata.duration) &&
          metadata.timestamp >= recordingAnchorMs &&
          metadata.duration >= 0,
      )
      .sort((a, b) => (a.metadata.depth || 0) - (b.metadata.depth || 0));
    if (timed.length === 0) continue;
    const selected = timed[0];
    const start = selected.metadata.timestamp;
    const completed = start + selected.metadata.duration;
    const event = {
      id: eventId,
      status: selected.metadata.status === 'COMPLETED' ? 'passed' : 'failed',
      startedAtMs: start,
      completedAtMs: completed,
      timingSource: 'maestro_commands_json',
      precision: 'command_metadata_not_touch_frame_exact',
      maestro: {
        status: selected.metadata.status || null,
        sequenceNumber: selected.metadata.sequenceNumber ?? null,
        depth: selected.metadata.depth ?? null,
      },
    };
    const actionEntries = entries.filter((entry) => {
      const timestamp = entry?.metadata?.timestamp;
      return Number.isFinite(timestamp) && timestamp >= start && timestamp <= completed;
    });
    if (
      actionEntries.some((entry) =>
        containsKey(
          entry?.metadata?.evaluatedCommand || entry?.command,
          new Set(['tapOnPointV2Command', 'tapOnPointCommand']),
        ),
      )
    ) {
      event.targetResolution = 'reviewed_coordinate';
    }
    observed.push(event);
  }
  return {
    observed,
    commandMetadataFiles: commandFiles.length,
    entryCount: entries.length,
  };
}

function createMaestroRunner(options = {}) {
  const commandRunner = options.commandRunner || createCommandRunner(options.spawn);
  const clock = options.clock || Date.now;
  const wait = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let version = null;

  function sanitizedTail(value, maxLength = 4096) {
    return String(value || '')
      .replace(
        /\b(password|token|authorization|cookie)(\s*[:=]\s*)\S+/gi,
        '$1$2[REDACTED]',
      )
      .slice(-maxLength);
  }

  async function runFlow(input, phase, yaml, eventIds, recordingAnchorMs) {
    const flowPath = path.join(input.tempDir, `${input.recipe.id}-${phase}.yaml`);
    const outputRoot = path.join(input.tempDir, `maestro-${phase}-output`);
    fs.mkdirSync(outputRoot, { recursive: true });
    fs.writeFileSync(flowPath, yaml, 'utf8');
    const result = await commandRunner.run(
      'maestro',
      [
        '--no-ansi',
        `--udid=${input.udid}`,
        'test',
        `--test-output-dir=${outputRoot}`,
        flowPath,
      ],
      {
        cwd: input.tempDir,
        env: MAESTRO_ENV,
        timeoutMs: 180000,
      },
    );
    const timing = parseMaestroTimings(outputRoot, eventIds, recordingAnchorMs);
    return { result, timing, outputRoot };
  }

  return {
    name: 'maestro',
    async prepare() {
      let result;
      try {
        result = await commandRunner.run('maestro', ['--version'], {
          env: MAESTRO_ENV,
          timeoutMs: 30000,
        });
      } catch (error) {
        throw new RecordingError(`找不到可執行的 Maestro：${error.message}`, 'runner_unavailable');
      }
      if (result.code !== 0) {
        throw new RecordingError('Maestro --version 失敗', 'runner_unavailable');
      }
      version = String(result.stdout || '').trim().split(/\r?\n/)[0] || 'unknown';
      return { name: 'maestro', version };
    },
    async preflightTarget(input) {
      const readiness = input.recipe.actions.find((action) => action.type === 'readiness');
      const eventIds = [
        'navigation.accept-chipk-open-confirmation',
        readiness.id,
        'session.login-absent',
      ];
      const { result, timing } = await runFlow(
        input,
        'pre-record',
        buildMaestroPreparationFlow(input.recipe, input.routePlan, input.bundleId),
        eventIds,
        0,
      );
      if (result.code !== 0) {
        throw new RecordingError(
          '錄影前目標頁驗證失敗：必須到達 K線/2324/readiness，且登入按鈕不可見',
          'session_preflight_failed',
          { observedEventIds: timing.observed.map((event) => event.id) },
        );
      }
      const passedIds = new Set(
        timing.observed.filter((event) => event.status === 'passed').map((event) => event.id),
      );
      if (eventIds.some((id) => !passedIds.has(id))) {
        throw new RecordingError(
          '錄影前 Maestro 缺少完整 readiness/session 證據',
          'session_preflight_evidence_incomplete',
        );
      }
      return {
        status: 'verified_by_maestro_before_recording',
        observedEvents: timing.observed,
        expectedEventIds: eventIds,
        artifactEvidence: {
          commandMetadataFiles: timing.commandMetadataFiles,
          commandEntryCount: timing.entryCount,
        },
      };
    },
    async runDiagnosticSingleFlow(input) {
      if (input.recipe.profile !== RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK) {
        throw new RecordingError('single-flow runner 只允許 diagnostic profile', 'profile_mismatch');
      }
      const { result, outputRoot } = await runFlow(
        input,
        'single-flow',
        buildMaestroDiagnosticSingleFlow(input.recipe, input.routePlan, input.bundleId),
        [],
        0,
      );
      if (result.code !== 0) {
        throw new RecordingError(
          '單次 Maestro Flow process 未成功；保留 bounded diagnostics 供定位',
          'runner_failed',
          {
            processExitCode: result.code,
            processSignal: result.signal || null,
            stderrTail: sanitizedTail(result.stderr),
            outputRoot: path.relative(input.tempDir, outputRoot),
          },
        );
      }
      const commandEvidence = singleFlowCommandEntries(outputRoot);
      const mapped = mapDiagnosticSingleFlowEvents(commandEvidence.records, input.recipe);
      const recording = resolveMaestroSingleFlowRecording(outputRoot, commandEvidence);
      return {
        runner: { name: 'maestro', version: version || 'unknown' },
        preRecordEvidence: {
          status: 'verified_inside_single_maestro_flow_before_recording',
          expectedEventIds: mapped.expectedPreRecordEventIds,
          observedEvents: mapped.preRecordEvents,
        },
        observedEvents: mapped.inRecordEvents,
        recording,
        artifactEvidence: {
          commandMetadataFiles: commandEvidence.commandFiles.length,
          commandEntryCount: commandEvidence.records.length,
          flowCount: 1,
          outputRoot: path.relative(input.tempDir, outputRoot),
          recordingArtifactSource: 'successful_startRecording_command_metadata',
        },
      };
    },
    async run(input) {
      const observedEvents = [];
      let commandMetadataFiles = 0;
      let commandEntryCount = 0;
      let phaseNumber = 0;
      let pendingActions = [];
      const flushPending = async () => {
        if (pendingActions.length === 0) return;
        phaseNumber += 1;
        const eventIds = pendingActions.map((action) => action.id);
        const { result, timing } = await runFlow(
          input,
          `interaction-${phaseNumber}`,
          buildMaestroFlow(input.recipe, input.routePlan, input.bundleId, eventIds),
          eventIds,
          input.recordingAnchorMs,
        );
        observedEvents.push(...timing.observed);
        commandMetadataFiles += timing.commandMetadataFiles;
        commandEntryCount += timing.entryCount;
        pendingActions = [];
        if (result.code !== 0) {
          const error = new RecordingError(
            'Maestro interaction flow 未完成；已停止並 finalize 暫存錄影',
            'runner_failed',
            { observedEventIds: observedEvents.map((event) => event.id) },
          );
          error.observedEvents = observedEvents;
          throw error;
        }
      };
      const inRecordActions = input.recipe.actions.filter((action) => action.type !== 'readiness');
      for (const [index, action] of inRecordActions.entries()) {
        if (action.type !== 'hold') {
          pendingActions.push(action);
          continue;
        }
        await flushPending();
        const startedAtMs = clock();
        const isFinalAction = index === inRecordActions.length - 1;
        const remainingToTarget = isFinalAction
          ? input.recipe.recordingDuration.targetMs - (startedAtMs - input.recordingAnchorMs)
          : 0;
        const durationMs = Math.max(action.durationMs, remainingToTarget);
        await wait(durationMs);
        observedEvents.push({
          id: action.id,
          status: 'passed',
          startedAtMs,
          completedAtMs: clock(),
          timingSource: 'local_hold_clock',
          precision: 'process_clock_not_video_frame_exact',
          plannedDurationMs: action.durationMs,
          actualDurationMs: durationMs,
        });
      }
      await flushPending();
      return {
        runner: { name: 'maestro', version: version || 'unknown' },
        observedEvents,
        artifactEvidence: {
          commandMetadataFiles,
          commandEntryCount,
        },
      };
    },
    cancel() {
      commandRunner.cancel?.();
    },
  };
}

function createSimctlVideoRecorder(options = {}) {
  const spawnImpl = options.spawn || spawn;
  const clock = options.clock || Date.now;
  const sigintTimeoutMs = options.sigintTimeoutMs ?? 10000;
  const sigtermTimeoutMs = options.sigtermTimeoutMs ?? 3000;
  const sigkillTimeoutMs = options.sigkillTimeoutMs ?? 2000;
  return {
    async start({ udid, videoPath }) {
      let stderr = '';
      let spawned = false;
      let closed = false;
      let closeResult = null;
      let resolveClose;
      const closePromise = new Promise((resolve) => {
        resolveClose = resolve;
      });
      const child = spawnImpl(
        'xcrun',
        ['simctl', 'io', udid, 'recordVideo', '--codec=h264', videoPath],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      child.stderr?.on('data', (chunk) => {
        if (stderr.length < 8192) stderr += String(chunk).slice(0, 8192 - stderr.length);
      });
      child.once('close', (code, signal) => {
        closed = true;
        closeResult = { code, signal };
        resolveClose(closeResult);
      });
      await new Promise((resolve, reject) => {
        let settled = false;
        child.once('spawn', () => {
          if (settled) return;
          settled = true;
          spawned = true;
          resolve();
        });
        child.once('error', (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        });
        child.once('close', () => {
          if (settled) return;
          settled = true;
          reject(new RecordingError('simctl recordVideo 在 spawn 前關閉', 'video_start_failed'));
        });
      });
      if (!spawned || closed) {
        throw new RecordingError(
          `simctl recordVideo 無法啟動${stderr ? `：${stderr.trim()}` : ''}`,
          'video_start_failed',
        );
      }
      const startedAtMs = clock();
      let stopped = false;
      let stopRequestedAtMs = null;
      const waitForClose = async (timeoutMs) => {
        if (closed) return true;
        return await new Promise((resolve) => {
          const timer = setTimeout(() => resolve(false), timeoutMs);
          closePromise.then(() => {
            clearTimeout(timer);
            resolve(true);
          });
        });
      };
      return {
        startedAtMs,
        async stop() {
          if (stopped) {
            return { ...(closeResult || {}), stopRequestedAtMs, stoppedAtMs: clock() };
          }
          stopped = true;
          stopRequestedAtMs = clock();
          const signalsSent = [];
          const stopWith = async (signal, timeoutMs) => {
            if (closed) return true;
            signalsSent.push(signal);
            child.kill(signal);
            return await waitForClose(timeoutMs);
          };
          if (!(await stopWith('SIGINT', sigintTimeoutMs))) {
            if (!(await stopWith('SIGTERM', sigtermTimeoutMs))) {
              await stopWith('SIGKILL', sigkillTimeoutMs);
            }
          }
          if (!closed) {
            throw new RecordingError(
              'simctl recordVideo 在 SIGINT/SIGTERM/SIGKILL 後仍未 reap',
              'video_reap_timeout',
              { signalsSent },
            );
          }
          const stoppedAtMs = clock();
          if (signalsSent.includes('SIGTERM') || signalsSent.includes('SIGKILL')) {
            throw new RecordingError(
              'simctl recordVideo 需要強制終止，不能信任 MP4 finalize',
              'video_finalize_forced',
              { ...closeResult, signalsSent },
            );
          }
          if (/\b(error|failed|failure|invalid|denied|unable)\b/i.test(stderr)) {
            throw new RecordingError(
              `simctl recordVideo stderr 顯示失敗：${stderr.trim()}`,
              'video_finalize_stderr',
              { ...closeResult, signalsSent },
            );
          }
          const acceptableExit =
            closeResult?.code === 0 ||
            (closeResult?.code === null && closeResult?.signal === 'SIGINT');
          if (!acceptableExit) {
            throw new RecordingError(
              'simctl recordVideo 以不可接受的狀態結束',
              'video_finalize_bad_exit',
              { ...closeResult, signalsSent, stderr: stderr.trim() },
            );
          }
          return {
            ...closeResult,
            signalsSent,
            stderr: stderr.trim(),
            stopRequestedAtMs,
            stoppedAtMs,
          };
        },
      };
    },
  };
}

function probeVideo(videoPath, exec = defaultExec) {
  let raw;
  try {
    raw = exec('ffprobe', [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=codec_name,width,height,duration:format=duration',
      '-of',
      'json',
      videoPath,
    ]);
  } catch (error) {
    throw new RecordingError(`ffprobe 無法驗證 raw video：${error.message}`, 'video_probe_failed');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new RecordingError('ffprobe 回傳無效 JSON', 'video_probe_invalid');
  }
  const stream = parsed.streams?.[0];
  const duration = Number(stream?.duration || parsed.format?.duration);
  if (
    !stream ||
    stream.codec_name !== 'h264' ||
    !Number.isInteger(stream.width) ||
    stream.width <= 0 ||
    !Number.isInteger(stream.height) ||
    stream.height <= 0 ||
    !Number.isFinite(duration) ||
    duration <= 0
  ) {
    throw new RecordingError('raw video 缺少有效 H.264 duration/dimensions', 'video_probe_invalid');
  }
  return {
    codec: stream.codec_name,
    durationSeconds: duration,
    width: stream.width,
    height: stream.height,
  };
}

function probePngDimensions(filePath) {
  const bytes = fs.readFileSync(filePath);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
    throw new RecordingError('layout probe 不是有效 PNG', 'layout_probe_invalid');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width <= 0 || height <= 0) {
    throw new RecordingError('layout probe 缺少有效 dimensions', 'layout_probe_invalid');
  }
  return { width, height, orientation: height > width ? 'portrait' : 'landscape' };
}

function captureLayoutProbe(udid, tempDir, exec = defaultExec) {
  const probePath = path.join(tempDir, 'layout-probe.png');
  try {
    exec('xcrun', ['simctl', 'io', udid, 'screenshot', '--type=png', probePath]);
    return probePngDimensions(probePath);
  } catch (error) {
    if (error instanceof RecordingError) throw error;
    throw new RecordingError(`無法取得 layout probe：${error.message}`, 'layout_probe_failed');
  } finally {
    try {
      fs.unlinkSync(probePath);
    } catch (_) {}
  }
}

function normalizedRuntime(value) {
  return String(value || '')
    .toLowerCase()
    .replace('com.apple.coresimulator.simruntime.', '')
    .replace(/[^a-z0-9]/g, '');
}

function validateReviewedLayout(recipe, preflight, probe) {
  const tap = recipe.actions.find((action) => action.type === 'tap');
  const expected = tap?.execution?.reviewedLayout;
  if (!expected) {
    throw new RecordingError('recipe 缺少 reviewed coordinate layout', 'layout_contract_missing');
  }
  const actual = {
    deviceName: preflight.device?.name,
    runtime: preflight.device?.runtime,
    screenshotWidth: probe?.width,
    screenshotHeight: probe?.height,
    orientation: probe?.orientation || (probe?.height > probe?.width ? 'portrait' : 'landscape'),
  };
  const matches =
    actual.deviceName === expected.deviceName &&
    normalizedRuntime(actual.runtime) === normalizedRuntime(expected.runtime) &&
    actual.screenshotWidth === expected.screenshotWidth &&
    actual.screenshotHeight === expected.screenshotHeight &&
    actual.orientation === expected.orientation;
  if (!matches) {
    throw new RecordingError(
      'reviewed coordinate layout 不符，拒絕執行座標 tap',
      'reviewed_layout_mismatch',
      { expected, actual },
    );
  }
  return { strategy: tap.execution.strategy, expected, actual, verified: true };
}

function outputPaths(input) {
  for (const key of ['video', 'actions', 'manifest']) {
    if (typeof input[key] !== 'string' || input[key].trim() === '') {
      throw new RecordingError(`--${key} 為必要參數`, `missing_${key}`);
    }
  }
  if (!input.video.toLowerCase().endsWith('.mp4')) {
    throw new RecordingError('--video 必須是 .mp4', 'invalid_video_path');
  }
  if (!input.actions.toLowerCase().endsWith('.json')) {
    throw new RecordingError('--actions 必須是 .json', 'invalid_actions_path');
  }
  if (!input.manifest.toLowerCase().endsWith('.json')) {
    throw new RecordingError('--manifest 必須是 .json', 'invalid_manifest_path');
  }
  const resolved = {
    video: path.resolve(input.video),
    actions: path.resolve(input.actions),
    manifest: path.resolve(input.manifest),
  };
  if (new Set(Object.values(resolved)).size !== 3) {
    throw new RecordingError('video/actions/manifest 必須是三個不同檔案', 'duplicate_output_path');
  }
  const parentDirs = new Set(Object.values(resolved).map((filePath) => path.dirname(filePath)));
  if (parentDirs.size !== 1) {
    throw new RecordingError(
      'video/actions/manifest 必須位於同一輸出目錄，才能以同一 filesystem 發布',
      'output_directory_mismatch',
    );
  }
  for (const [key, filePath] of Object.entries(resolved)) {
    if (fs.existsSync(filePath)) {
      throw new RecordingError(`${key} 已存在，拒絕覆寫：${filePath}`, 'output_exists');
    }
  }
  return resolved;
}

function deriveVideoTimelineCalibration(
  recordingStartedAtMs,
  recordingStopRequestedAtMs,
  recordingStoppedAtMs,
  encodedDurationMs,
) {
  const captureStopAtMs = Number.isFinite(recordingStopRequestedAtMs)
    ? recordingStopRequestedAtMs
    : recordingStoppedAtMs;
  if (
    !Number.isFinite(recordingStartedAtMs) ||
    !Number.isFinite(captureStopAtMs) ||
    !Number.isFinite(recordingStoppedAtMs) ||
    !Number.isFinite(encodedDurationMs) ||
    captureStopAtMs < recordingStartedAtMs ||
    recordingStoppedAtMs < captureStopAtMs ||
    encodedDurationMs <= 0
  ) {
    throw new RecordingError('無法建立 raw video timeline calibration', 'timeline_calibration_invalid');
  }
  const processCaptureElapsedMs = captureStopAtMs - recordingStartedAtMs;
  const processMinusEncodedMs = processCaptureElapsedMs - encodedDurationMs;
  const estimatedEncoderStartOffsetMs = Math.max(0, processMinusEncodedMs);
  return {
    method: 'align_encoded_end_to_recorder_stop_request',
    semantics:
      'videoOffsetMs = processOffsetMs - estimatedEncoderStartOffsetMs; positive process-minus-encoded duration is treated as estimated non-encoded startup lead-in',
    assumption:
      'the final encoded frame aligns with the recorder stop-request boundary; estimate is not frame-exact',
    precision: 'process_clock_and_ffprobe_duration_estimate_not_frame_exact',
    processCaptureElapsedMs,
    encodedDurationMs,
    processMinusEncodedMs,
    estimatedEncoderStartOffsetMs,
    recorderFinalizeElapsedMs: recordingStoppedAtMs - captureStopAtMs,
  };
}

function observedForOutput(
  event,
  recordingStartedAtMs,
  recordingStoppedAtMs,
  encodedDurationMs,
  timelineCalibration,
  toleranceMs = VIDEO_TIMELINE_TOLERANCE_MS,
) {
  if (
    !Number.isFinite(event.startedAtMs) ||
    !Number.isFinite(event.completedAtMs) ||
    event.startedAtMs < recordingStartedAtMs ||
    event.completedAtMs < event.startedAtMs ||
    event.completedAtMs > recordingStoppedAtMs + toleranceMs
  ) {
    throw new RecordingError(`event timing 無效：${event.id}`, 'event_timing_invalid');
  }
  const calibrationMs = timelineCalibration?.estimatedEncoderStartOffsetMs || 0;
  const processStartedOffsetMs = event.startedAtMs - recordingStartedAtMs;
  const processCompletedOffsetMs = event.completedAtMs - recordingStartedAtMs;
  const mappedStartedOffsetMs = processStartedOffsetMs - calibrationMs;
  const mappedCompletedOffsetMs = processCompletedOffsetMs - calibrationMs;
  if (mappedCompletedOffsetMs < -toleranceMs) {
    throw new RecordingError(
      `event 發生在估算的第一個 encoded frame 之前：${event.id}`,
      'event_before_video_timeline',
      { mappedCompletedOffsetMs, calibrationMs, toleranceMs },
    );
  }
  const startedOffsetMs = Math.max(0, mappedStartedOffsetMs);
  const completedOffsetMs = Math.max(0, mappedCompletedOffsetMs);
  if (completedOffsetMs > encodedDurationMs + toleranceMs) {
    throw new RecordingError(
      `event 超出 raw video timeline：${event.id}`,
      'event_outside_video_timeline',
      {
        processCompletedOffsetMs,
        completedOffsetMs,
        encodedDurationMs,
        calibrationMs,
        toleranceMs,
      },
    );
  }
  return {
    id: event.id,
    status: event.status,
    startedAt: new Date(event.startedAtMs).toISOString(),
    completedAt: new Date(event.completedAtMs).toISOString(),
    startedOffsetMs,
    completedOffsetMs,
    processStartedOffsetMs,
    processCompletedOffsetMs,
    timelineCalibrationAppliedMs: calibrationMs,
    ...(mappedStartedOffsetMs < 0 ? { clippedAtVideoStart: true } : {}),
    elapsedMs: event.completedAtMs - event.startedAtMs,
    timingSource: event.timingSource,
    precision: event.precision,
    ...(event.targetResolution ? { targetResolution: event.targetResolution } : {}),
    ...(Number.isFinite(event.plannedDurationMs)
      ? { plannedDurationMs: event.plannedDurationMs }
      : {}),
    ...(Number.isFinite(event.actualDurationMs) ? { actualDurationMs: event.actualDurationMs } : {}),
    ...(event.maestro ? { maestro: event.maestro } : {}),
  };
}

function writeJsonExclusive(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
  });
}

function publishArtifactsAtomically(staged, destinations, fsImpl = fs) {
  const published = [];
  try {
    for (const key of ['video', 'actions', 'manifest']) {
      fsImpl.linkSync(staged[key], destinations[key]);
      published.push(destinations[key]);
    }
  } catch (error) {
    for (const filePath of published.reverse()) {
      try {
        fsImpl.unlinkSync(filePath);
      } catch (_) {}
    }
    throw new RecordingError(
      `無法完整發布 recording artifacts：${error.message}`,
      'artifact_publish_failed',
    );
  }
}

const PIPELINE_STAGE_IDS = Object.freeze([
  'runner_prepare',
  'device_preflight',
  'route_navigation',
  'target_readiness',
  'layout_probe',
  'single_flow',
  'recorder_start',
  'interaction',
  'recorder_finalize',
  'video_probe',
  'artifact_preparation',
]);

function createPipelineTimingTracker(clock = Date.now) {
  const stages = [];

  const timestamp = () => {
    const value = clock();
    if (!Number.isFinite(value)) {
      throw new RecordingError('stageClock 必須回傳 epoch milliseconds', 'invalid_stage_clock');
    }
    return value;
  };

  const start = (stage) => {
    if (!PIPELINE_STAGE_IDS.includes(stage)) {
      throw new RecordingError(`未知 pipeline stage：${stage}`, 'unknown_pipeline_stage');
    }
    if (stages.some((entry) => entry.stage === stage)) {
      throw new RecordingError(`pipeline stage 重複：${stage}`, 'duplicate_pipeline_stage');
    }
    const startedAtMs = timestamp();
    const entry = { stage, startedAtMs, completedAtMs: null, status: 'running' };
    stages.push(entry);
    return entry;
  };

  const finish = (entry, status, error = null) => {
    if (!entry || entry.status !== 'running') return;
    entry.completedAtMs = timestamp();
    entry.status = status;
    if (error) entry.errorCode = error.code || error.name || 'unknown_error';
  };

  const snapshot = () => ({
    semantics: 'process_wall_clock_not_recording_timeline',
    stages: stages.map((entry) => ({
      stage: entry.stage,
      startedAt: new Date(entry.startedAtMs).toISOString(),
      completedAt:
        entry.completedAtMs === null ? null : new Date(entry.completedAtMs).toISOString(),
      durationMs:
        entry.completedAtMs === null ? null : Math.max(0, entry.completedAtMs - entry.startedAtMs),
      status: entry.status,
      ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    })),
  });

  const attach = (error) => {
    if (!error || typeof error !== 'object') return error;
    const existing =
      error.details && typeof error.details === 'object' && !Array.isArray(error.details)
        ? error.details
        : {};
    error.details = { ...existing, pipelineTimings: snapshot() };
    return error;
  };

  const run = async (stage, operation) => {
    const entry = start(stage);
    try {
      const result = await operation();
      finish(entry, 'passed');
      return result;
    } catch (error) {
      finish(entry, 'failed', error);
      throw attach(error);
    }
  };

  return { attach, finish, run, snapshot, start };
}

async function completeDiagnosticArtifacts({
  catalog,
  recipe,
  plan,
  routePlan,
  destinations,
  staged,
  preflight,
  layoutEvidence,
  udid,
  routeNavigationEvidence,
  runnerInfo,
  runnerResult,
  pipelineTimings,
  deps,
}) {
  const recordingStartedAtMs = runnerResult.recording.recordingStartedAtMs;
  const recordingStopRequestedAtMs = runnerResult.recording.stopRequestedAtMs;
  const recordingStoppedAtMs = runnerResult.recording.recordingStoppedAtMs;
  const { videoProbe, encodedDurationMs } = await pipelineTimings.run('video_probe', async () => {
    if (!fs.existsSync(staged.video) || fs.statSync(staged.video).size === 0) {
      throw new RecordingError('Maestro 未產生有效 raw video', 'video_missing');
    }
    const probe = deps.probeVideo
      ? await deps.probeVideo(staged.video)
      : probeVideo(staged.video, deps.exec || defaultExec);
    const durationMs = Math.round(probe.durationSeconds * 1000);
    if (durationMs < recipe.recordingDuration.minMs || durationMs > recipe.recordingDuration.maxMs) {
      throw new RecordingError(
        'raw video duration 不在 diagnostic recipe 指定範圍',
        'recording_duration_out_of_range',
        { expected: recipe.recordingDuration, encodedDurationMs: durationMs },
      );
    }
    return { videoProbe: probe, encodedDurationMs: durationMs };
  });
  const timelineCalibration = deriveVideoTimelineCalibration(
    recordingStartedAtMs,
    recordingStopRequestedAtMs,
    recordingStoppedAtMs,
    encodedDurationMs,
  );
  const artifactPreparationStage = pipelineTimings.start('artifact_preparation');
  try {
    const observed = (runnerResult.observedEvents || []).map((event) =>
      observedForOutput(
        event,
        recordingStartedAtMs,
        recordingStoppedAtMs,
        encodedDurationMs,
        timelineCalibration,
      ),
    );
    const inRecordPlanned = plan.planned.filter((event) => event.phase === 'in_record');
    const expectedEventIds = inRecordPlanned.map((event) => event.id);
    const observedIds = new Set(
      observed.filter((event) => event.status === 'passed').map((event) => event.id),
    );
    const missingObservedEventIds = expectedEventIds.filter((id) => !observedIds.has(id));
    const actionsPayload = {
      schemaVersion: 1,
      recipe: plan.recipe,
      routeId: recipe.routeId,
      recording: {
        startedAt: new Date(recordingStartedAtMs).toISOString(),
        stoppedAt: new Date(recordingStoppedAtMs).toISOString(),
        anchorSemantics: 'maestro_startRecording_command_completion_not_first_video_frame',
        encodedDurationMs,
        anchorToleranceMs: VIDEO_TIMELINE_TOLERANCE_MS,
        timelineCalibration,
      },
      runner: runnerResult.runner || runnerInfo,
      timing: {
        plannedSemantics: 'in_record_recipe_intent_without_observed_offsets',
        observedSemantics:
          'single_maestro_flow_command_timing_mapped_to_estimated_encoded_video_start_not_physical_touch_or_frame_timing',
        observedComplete: missingObservedEventIds.length === 0,
        missingObservedEventIds,
      },
      planned: inRecordPlanned,
      observed,
    };
    writeJsonExclusive(staged.actions, actionsPayload);
    const actionsDigest = sha256File(staged.actions);
    const videoDigest = sha256File(staged.video);
    const preRecordEvents = [
      routeNavigationEvidence,
      ...(runnerResult.preRecordEvidence?.observedEvents || []),
    ];
    const preRecordEventTrace = preRecordEvents.map((event) => ({
      id: event.id,
      status: event.status,
      ...(Number.isFinite(event.startedAtMs)
        ? { startedAt: new Date(event.startedAtMs).toISOString() }
        : {}),
      ...(Number.isFinite(event.completedAtMs)
        ? { completedAt: new Date(event.completedAtMs).toISOString() }
        : {}),
      timingSource: event.timingSource || null,
      precision: event.precision || null,
      source: event.source || null,
    }));
    const manifest = {
      schemaVersion: 1,
      status: 'recorded_pending_human_review',
      recipe: plan.recipe,
      mode: recipe.mode,
      route: {
        ...routePlan.route,
        resolvedUrl: routePlan.url,
        parameters: routePlan.parameters,
      },
      navigation: {
        status: 'verified_by_simctl_and_single_maestro_flow_before_recording',
        phase: 'single_flow_pre_record_commands',
        expectedTexts: routePlan.expectedTexts,
        evidenceEventIds: [
          routeNavigationEvidence.id,
          ...(runnerResult.preRecordEvidence?.expectedEventIds || []),
        ],
        eventTrace: preRecordEventTrace,
        rawTimelineOffsets: 'not_applicable_commands_completed_before_startRecording',
        reviewedCoordinateLayout: layoutEvidence,
      },
      material: {
        ...recipe.material,
        freshCapture: true,
        reviewStatus: 'pending_human_review',
        historicalMismatchPolicy: 'allowed_by_test_mode',
        timelineUsable: missingObservedEventIds.length === 0,
        resultAssertion: 'passed_inside_single_maestro_flow',
      },
      udid,
      bundle: preflight.bundle,
      device: preflight.device,
      recording: {
        startedAt: actionsPayload.recording.startedAt,
        stoppedAt: actionsPayload.recording.stoppedAt,
        anchorSemantics: actionsPayload.recording.anchorSemantics,
        anchorToleranceMs: VIDEO_TIMELINE_TOLERANCE_MS,
        timelineCalibration,
        boundarySemantics: runnerResult.recording.boundarySemantics,
        stagingMethod: runnerResult.recording.stagingMethod,
        ...videoProbe,
      },
      runner: actionsPayload.runner,
      eventTrace: observed,
      artifactEvidence: {
        preRecord: {
          navigation: routeNavigationEvidence.processEvidence || null,
          maestro: runnerResult.artifactEvidence || null,
        },
        inRecord: runnerResult.artifactEvidence || null,
      },
      artifacts: {
        rawVideo: { file: path.basename(destinations.video), sha256: videoDigest },
        actions: { file: path.basename(destinations.actions), sha256: actionsDigest },
      },
      catalogVersion: catalog.catalogVersion || null,
      sourceVersion: getSourceVersion(catalog),
    };
    pipelineTimings.finish(artifactPreparationStage, 'passed');
    manifest.pipelineTimings = pipelineTimings.snapshot();
    writeJsonExclusive(staged.manifest, manifest);
    (deps.publishArtifacts || publishArtifactsAtomically)(staged, destinations);
    return {
      ok: true,
      video: destinations.video,
      actions: destinations.actions,
      manifest: destinations.manifest,
      route_selection: 'catalog_recipe_exact_match',
      navigation: manifest.navigation.status,
      material: manifest.material.reviewStatus,
      durationSeconds: videoProbe.durationSeconds,
      observedComplete: actionsPayload.timing.observedComplete,
    };
  } catch (error) {
    pipelineTimings.finish(artifactPreparationStage, 'failed', error);
    throw error;
  }
}

async function recordRecipe(catalog, recipeFile, input, deps = {}) {
  if (input.confirmVipSession !== true) {
    throw new RecordingError(
      'record 前必須確認指定 Simulator 是已 preflight 的 VIP session，並加上 --confirm-vip-session',
      'vip_session_confirmation_required',
    );
  }
  if (input.runnerName !== undefined && input.runnerName !== 'maestro') {
    throw new RecordingError(`不支援 runner：${input.runnerName}`, 'unsupported_runner');
  }
  if (!UDID_RE.test(input.udid || '')) {
    throw new RecordingError('--udid 必須是完整 Simulator UDID', 'invalid_udid');
  }
  const destinations = outputPaths(input);
  const plan = planRecipe(catalog, recipeFile, input.recipe);
  const recipe = getRecipe(recipeFile, input.recipe);
  const routePlan = buildPlan(catalog, {
    route: recipe.routeId,
    mode: recipe.mode,
    stockId: recipe.stock.id,
    stockName: recipe.stock.name,
  });
  if (input.currentTarget === true && routePlan.route.requiresRootNavigation === true) {
    throw new RecordingError(
      `route ${routePlan.route.id} 必須執行 root navigation，不能使用 --current-target`,
      'root_navigation_required',
      { routeId: routePlan.route.id },
    );
  }
  const pipelineTimings = createPipelineTimingTracker(deps.stageClock || Date.now);
  const runner = deps.runner || createMaestroRunner(deps.maestroOptions);
  const runnerInfo = await pipelineTimings.run('runner_prepare', async () =>
    runner.prepare
      ? runner.prepare()
      : { name: runner.name || 'injected', version: 'adapter-reported' },
  );
  const preflight = await pipelineTimings.run('device_preflight', async () =>
    (deps.preflight || runRecordingPreflight)(catalog, input.udid, deps),
  );
  const outputDir = path.dirname(destinations.video);
  fs.mkdirSync(outputDir, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(outputDir, '.chipk-simulator-record-'));
  const staged = {
    video: path.join(tempDir, 'raw.mp4'),
    actions: path.join(tempDir, 'actions.json'),
    manifest: path.join(tempDir, 'recording-manifest.json'),
  };
  const clock = deps.clock || Date.now;
  const videoRecorder = deps.videoRecorder || createSimctlVideoRecorder({ clock });
  let videoHandle;
  let runnerResult;
  let runnerError;
  let stopResult;
  let interruptedBy = null;
  const signalEmitter = deps.signalEmitter || process;
  const onInterrupt = (signal) => {
    interruptedBy = signal;
    runner.cancel?.(signal);
  };
  const onSigInt = () => onInterrupt('SIGINT');
  const onSigTerm = () => onInterrupt('SIGTERM');
  try {
    const isDiagnosticSingleFlow =
      recipe.profile === RECIPE_PROFILES.DIAGNOSTIC_TAB_SWITCH_BENCHMARK;
    if (isDiagnosticSingleFlow && typeof runner.runDiagnosticSingleFlow !== 'function') {
      throw new RecordingError(
        'runner adapter 缺少 diagnostic single-flow 支援',
        'runner_single_flow_unsupported',
      );
    }
    if (!isDiagnosticSingleFlow && typeof runner.preflightTarget !== 'function') {
      throw new RecordingError(
        'runner adapter 缺少錄影前 target/session machine preflight',
        'runner_preflight_unsupported',
      );
    }
    const currentTargetObservedAtMs = clock();
    const expectedNavigationId = input.currentTarget
      ? 'navigation.current-target'
      : 'navigation.open-route';
    const expectedNavigationSource = input.currentTarget
      ? 'operator_requested_warm_current_target'
      : 'xcrun_simctl_openurl_process';
    const routeNavigationEvidence = await pipelineTimings.run('route_navigation', async () => {
      const evidence = input.currentTarget
        ? {
            id: 'navigation.current-target',
            type: 'navigation',
            status: 'passed',
            source: 'operator_requested_warm_current_target',
            udid: input.udid,
            url: routePlan.url,
            startedAtMs: currentTargetObservedAtMs,
            completedAtMs: currentTargetObservedAtMs,
            timingSource: 'operator_request_plus_following_maestro_readiness',
            precision: 'pre_record_state_attestation',
            processEvidence: {
              mode: 'current_target',
              openUrlExecuted: false,
            },
          }
        : (deps.routeOpener || openRouteWithSimctl)(input.udid, routePlan.url, {
            exec: deps.exec || defaultExec,
            clock,
          });
      if (
        evidence?.id !== expectedNavigationId ||
        evidence?.status !== 'passed' ||
        evidence?.source !== expectedNavigationSource
      ) {
        throw new RecordingError(
          input.currentTarget
            ? '錄影前缺少可驗證的 current-target 暖啟動證據'
            : '錄影前缺少可驗證的 simctl openurl navigation 證據',
          'route_open_evidence_incomplete',
        );
      }
      return evidence;
    });
    if (isDiagnosticSingleFlow) {
      const layoutEvidence = await pipelineTimings.run('layout_probe', async () => {
        const layoutProbe = deps.layoutProbe
          ? await deps.layoutProbe({ udid: input.udid, tempDir, preflight, recipe })
          : captureLayoutProbe(input.udid, tempDir, deps.exec || defaultExec);
        return validateReviewedLayout(recipe, preflight, layoutProbe);
      });
      signalEmitter.once?.('SIGINT', onSigInt);
      signalEmitter.once?.('SIGTERM', onSigTerm);
      let singleFlowResult;
      try {
        singleFlowResult = await pipelineTimings.run('single_flow', async () => {
          const result = await runner.runDiagnosticSingleFlow({
            udid: input.udid,
            bundleId: catalog.product.bundleId,
            recipe,
            routePlan,
            tempDir,
          });
          const stagingMethod = (deps.stageMaestroVideo || stageMaestroVideo)(
            result.recording.videoPath,
            staged.video,
          );
          return {
            ...result,
            recording: { ...result.recording, stagingMethod },
          };
        });
      } finally {
        signalEmitter.removeListener?.('SIGINT', onSigInt);
        signalEmitter.removeListener?.('SIGTERM', onSigTerm);
      }
      if (interruptedBy) {
        throw new RecordingError(
          `單次 Maestro Flow 收到 ${interruptedBy}；不發布 partial artifacts`,
          'recording_interrupted',
        );
      }
      return await completeDiagnosticArtifacts({
        catalog,
        recipe,
        plan,
        routePlan,
        destinations,
        staged,
        preflight,
        layoutEvidence,
        udid: input.udid,
        routeNavigationEvidence,
        runnerInfo,
        runnerResult: singleFlowResult,
        pipelineTimings,
        deps,
      });
    }
    const maestroPreRecordEvidence = await pipelineTimings.run('target_readiness', async () => {
      const evidence = await runner.preflightTarget({
        udid: input.udid,
        bundleId: catalog.product.bundleId,
        recipe,
        routePlan,
        tempDir,
      });
      if (evidence?.status !== 'verified_by_maestro_before_recording') {
        throw new RecordingError(
          '錄影前 readiness/session 尚未由 Maestro 完整驗證',
          'session_preflight_evidence_incomplete',
        );
      }
      return evidence;
    });
    const preRecordEvidence = {
      status: input.currentTarget
        ? 'verified_current_target_by_maestro_before_recording'
        : 'verified_by_simctl_and_maestro_before_recording',
      expectedEventIds: [
        expectedNavigationId,
        ...(maestroPreRecordEvidence.expectedEventIds || []),
      ],
      observedEvents: [
        routeNavigationEvidence,
        ...(maestroPreRecordEvidence.observedEvents || []),
      ],
      artifactEvidence: {
        navigation: routeNavigationEvidence.processEvidence || null,
        maestro: maestroPreRecordEvidence.artifactEvidence || null,
      },
    };
    const layoutEvidence = await pipelineTimings.run('layout_probe', async () => {
      const layoutProbe = deps.layoutProbe
        ? await deps.layoutProbe({ udid: input.udid, tempDir, preflight, recipe })
        : captureLayoutProbe(input.udid, tempDir, deps.exec || defaultExec);
      return validateReviewedLayout(recipe, preflight, layoutProbe);
    });
    videoHandle = await pipelineTimings.run('recorder_start', async () =>
      videoRecorder.start({
        udid: input.udid,
        videoPath: staged.video,
      }),
    );
    signalEmitter.once?.('SIGINT', onSigInt);
    signalEmitter.once?.('SIGTERM', onSigTerm);
    try {
      runnerResult = await pipelineTimings.run('interaction', async () =>
        runner.run({
          udid: input.udid,
          bundleId: catalog.product.bundleId,
          recipe,
          routePlan,
          recordingAnchorMs: videoHandle.startedAtMs,
          tempDir,
        }),
      );
    } catch (error) {
      runnerError = error;
    } finally {
      signalEmitter.removeListener?.('SIGINT', onSigInt);
      signalEmitter.removeListener?.('SIGTERM', onSigTerm);
      try {
        stopResult = await pipelineTimings.run('recorder_finalize', async () => videoHandle.stop());
      } catch (error) {
        throw new RecordingError(`raw video 未能 finalize：${error.message}`, 'video_finalize_failed', {
          causeCode: error.code || null,
        });
      }
    }
    if (interruptedBy) {
      throw new RecordingError(
        `錄影收到 ${interruptedBy}；暫存 video 已 finalize，但不發布 partial artifacts`,
        'recording_interrupted',
      );
    }
    if (runnerError) throw runnerError;
    const recordingStartedAtMs = videoHandle.startedAtMs;
    const recordingStoppedAtMs = stopResult?.stoppedAtMs || clock();
    const { videoProbe, encodedDurationMs } = await pipelineTimings.run(
      'video_probe',
      async () => {
        if (!fs.existsSync(staged.video) || fs.statSync(staged.video).size === 0) {
          throw new RecordingError('simctl 未產生有效 raw video', 'video_missing');
        }
        const probe = deps.probeVideo
          ? await deps.probeVideo(staged.video)
          : probeVideo(staged.video, deps.exec || defaultExec);
        const durationMs = Math.round(probe.durationSeconds * 1000);
        if (
          durationMs < recipe.recordingDuration.minMs ||
          durationMs > recipe.recordingDuration.maxMs
        ) {
          throw new RecordingError(
            'raw video duration 不在 recipe 指定範圍',
            'recording_duration_out_of_range',
            { expected: recipe.recordingDuration, encodedDurationMs: durationMs },
          );
        }
        return { videoProbe: probe, encodedDurationMs: durationMs };
      },
    );
    const timelineCalibration = deriveVideoTimelineCalibration(
      recordingStartedAtMs,
      stopResult?.stopRequestedAtMs,
      recordingStoppedAtMs,
      encodedDurationMs,
    );
    const artifactPreparationStage = pipelineTimings.start('artifact_preparation');
    try {
    const observed = (runnerResult.observedEvents || []).map((event) =>
      observedForOutput(
        event,
        recordingStartedAtMs,
        recordingStoppedAtMs,
        encodedDurationMs,
        timelineCalibration,
      ),
    );
    const inRecordPlanned = plan.planned.filter((event) => event.phase === 'in_record');
    const expectedEventIds = inRecordPlanned.map((event) => event.id);
    const observedIds = new Set(
      observed.filter((event) => event.status === 'passed').map((event) => event.id),
    );
    const missingObservedEventIds = expectedEventIds.filter((id) => !observedIds.has(id));
    const actionsPayload = {
      schemaVersion: 1,
      recipe: plan.recipe,
      routeId: recipe.routeId,
      recording: {
        startedAt: new Date(recordingStartedAtMs).toISOString(),
        stoppedAt: new Date(recordingStoppedAtMs).toISOString(),
        anchorSemantics: 'simctl_process_spawn_boundary_not_first_video_frame',
        encodedDurationMs,
        anchorToleranceMs: VIDEO_TIMELINE_TOLERANCE_MS,
        timelineCalibration,
      },
      runner: runnerResult.runner || runnerInfo,
      timing: {
        plannedSemantics: 'in_record_recipe_intent_without_observed_offsets',
        observedSemantics:
          'command_or_local_process_timing_mapped_to_estimated_encoded_video_start_not_physical_touch_or_frame_timing',
        observedComplete: missingObservedEventIds.length === 0,
        missingObservedEventIds,
      },
      planned: inRecordPlanned,
      observed,
    };
    writeJsonExclusive(staged.actions, actionsPayload);
    const actionsDigest = sha256File(staged.actions);
    const videoDigest = sha256File(staged.video);
    const preRecordEventTrace = (preRecordEvidence.observedEvents || []).map((event) => ({
      id: event.id,
      status: event.status,
      ...(Number.isFinite(event.startedAtMs)
        ? { startedAt: new Date(event.startedAtMs).toISOString() }
        : {}),
      ...(Number.isFinite(event.completedAtMs)
        ? { completedAt: new Date(event.completedAtMs).toISOString() }
        : {}),
      timingSource: event.timingSource || null,
      precision: event.precision || null,
      source: event.source || null,
    }));
    const manifest = {
      schemaVersion: 1,
      status: 'recorded_pending_human_review',
      recipe: plan.recipe,
      mode: recipe.mode,
      route: {
        ...routePlan.route,
        resolvedUrl: routePlan.url,
        parameters: routePlan.parameters,
      },
      navigation: {
        status: preRecordEvidence.status,
        phase: 'pre_record',
        expectedTexts: routePlan.expectedTexts,
        evidenceEventIds: preRecordEvidence.expectedEventIds || [],
        eventTrace: preRecordEventTrace,
        rawTimelineOffsets: 'not_applicable_pre_record',
        reviewedCoordinateLayout: layoutEvidence,
      },
      material: {
        ...recipe.material,
        freshCapture: true,
        reviewStatus: 'pending_human_review',
        historicalMismatchPolicy: 'allowed_by_test_mode',
        timelineUsable: missingObservedEventIds.length === 0,
      },
      udid: input.udid,
      bundle: preflight.bundle,
      device: preflight.device,
      recording: {
        startedAt: actionsPayload.recording.startedAt,
        stoppedAt: actionsPayload.recording.stoppedAt,
        anchorSemantics: actionsPayload.recording.anchorSemantics,
        anchorToleranceMs: VIDEO_TIMELINE_TOLERANCE_MS,
        timelineCalibration,
        ...videoProbe,
      },
      runner: actionsPayload.runner,
      eventTrace: observed,
      artifactEvidence: {
        preRecord: preRecordEvidence.artifactEvidence || null,
        inRecord: runnerResult.artifactEvidence || null,
      },
      artifacts: {
        rawVideo: {
          file: path.basename(destinations.video),
          sha256: videoDigest,
        },
        actions: {
          file: path.basename(destinations.actions),
          sha256: actionsDigest,
        },
      },
      catalogVersion: catalog.catalogVersion || null,
      sourceVersion: getSourceVersion(catalog),
    };
    pipelineTimings.finish(artifactPreparationStage, 'passed');
    manifest.pipelineTimings = pipelineTimings.snapshot();
    writeJsonExclusive(staged.manifest, manifest);
    (deps.publishArtifacts || publishArtifactsAtomically)(staged, destinations);
    return {
      ok: true,
      video: destinations.video,
      actions: destinations.actions,
      manifest: destinations.manifest,
      route_selection: 'catalog_recipe_exact_match',
      navigation: manifest.navigation.status,
      material: manifest.material.reviewStatus,
      durationSeconds: videoProbe.durationSeconds,
      observedComplete: actionsPayload.timing.observedComplete,
    };
    } catch (error) {
      pipelineTimings.finish(artifactPreparationStage, 'failed', error);
      throw error;
    }
  } catch (error) {
    throw pipelineTimings.attach(error);
  } finally {
    signalEmitter.removeListener?.('SIGINT', onSigInt);
    signalEmitter.removeListener?.('SIGTERM', onSigTerm);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (_) {}
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const values = Object.create(null);
  const booleans = new Set(['json', 'confirm-vip-session', 'current-target']);
  const allowed = {
    'recipe-check': new Set(['json']),
    plan: new Set(['recipe', 'json']),
    record: new Set([
      'recipe',
      'runner',
      'udid',
      'confirm-vip-session',
      'current-target',
      'video',
      'actions',
      'manifest',
      'json',
    ]),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new RecordingError(`無法識別的參數：${item}`, 'unknown_argument');
    const equalAt = item.indexOf('=');
    const key = item.slice(2, equalAt >= 0 ? equalAt : undefined);
    if (allowed[command] && !allowed[command].has(key)) {
      throw new RecordingError(`${command} 不允許 flag：--${key}`, 'unknown_flag');
    }
    if (booleans.has(key)) {
      if (equalAt >= 0) throw new RecordingError(`--${key} 不接受值`, 'invalid_boolean_flag');
      if (values[key] !== undefined) throw new RecordingError(`--${key} 不得重複`, 'duplicate_argument');
      values[key] = true;
      continue;
    }
    const value = equalAt >= 0 ? item.slice(equalAt + 1) : argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new RecordingError(`--${key} 缺少值`, 'missing_value');
    }
    if (values[key] !== undefined) throw new RecordingError(`--${key} 不得重複`, 'duplicate_argument');
    values[key] = value;
  }
  return { command, values };
}

function print(value, json) {
  process.stdout.write(`${JSON.stringify(value, null, json ? 2 : 2)}\n`);
}

function usage() {
  return [
    '用法：',
    '  node scripts/simulator-record.js recipe-check [--json]',
    '  node scripts/simulator-record.js plan --recipe <id> [--json]',
    '  node scripts/simulator-record.js record --recipe <id> --runner maestro --udid <exact-udid> --confirm-vip-session [--current-target] --video <new.mp4> --actions <new.json> --manifest <new.json> [--json]',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const catalog = readCatalog();
  const recipeFile = readRecipes(catalog);
  if (command === 'recipe-check') {
    print({ ...validateRecipes(recipeFile, catalog), recipes: RECIPES_PATH }, values.json);
    return;
  }
  if (command === 'plan') {
    print(planRecipe(catalog, recipeFile, values.recipe), values.json);
    return;
  }
  if (command === 'record') {
    print(
      await recordRecipe(catalog, recipeFile, {
        recipe: values.recipe,
        runnerName: values.runner || 'maestro',
        udid: values.udid,
        confirmVipSession: values['confirm-vip-session'] === true,
        currentTarget: values['current-target'] === true,
        video: values.video,
        actions: values.actions,
        manifest: values.manifest,
      }),
      values.json,
    );
    return;
  }
  throw new RecordingError(`未知 command：${command}\n${usage()}`, 'unknown_command');
}

if (require.main === module) {
  main().catch((error) => {
    const json = process.argv.includes('--json');
    const payload = {
      ok: false,
      error: error.code || (error instanceof CliError ? error.code : 'unexpected_error'),
      message: error.message,
    };
    if (error.details) payload.details = error.details;
    process.stderr.write(`${json ? JSON.stringify(payload, null, 2) : `錯誤：${error.message}`}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAESTRO_ENV,
  RECIPES_PATH,
  RecordingError,
  VIDEO_TIMELINE_TOLERANCE_MS,
  buildMaestroDiagnosticSingleFlow,
  buildMaestroFlow,
  buildMaestroPreparationFlow,
  captureLayoutProbe,
  commandsPathsFromArtifacts,
  createMaestroRunner,
  deriveVideoTimelineCalibration,
  createSimctlVideoRecorder,
  getRecipe,
  outputPaths,
  mapDiagnosticSingleFlowEvents,
  parseArgs,
  parseMaestroTimings,
  resolveMaestroSingleFlowRecording,
  planRecipe,
  openRouteWithSimctl,
  observedForOutput,
  probePngDimensions,
  probeVideo,
  publishArtifactsAtomically,
  readRecipes,
  recordRecipe,
  recipeHash,
  runRecordingPreflight,
  stageMaestroVideo,
  validateReviewedLayout,
  validateRecipes,
};
