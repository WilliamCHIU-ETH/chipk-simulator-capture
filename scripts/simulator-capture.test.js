'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  CliError,
  buildPlan,
  captureRoute,
  exactSimulator,
  getSourceVersion,
  matchedExpectedTexts,
  matchedSparseExpectedTexts,
  parseArgs,
  readCatalog,
  resolveStock,
  suggestRoutes,
  validateCatalog,
} = require('./simulator-capture');
const ocrGeometryFixture = require('../fixtures/synthetic/ocr-readiness-geometry.json');

function fixtureCatalog() {
  return {
    schemaVersion: 1,
    source: { version: 'fixture-v1' },
    product: {
      bundleId: 'CMoney.Chipk',
      customScheme: 'chipk',
      landingHost: 'www.cmoney.tw',
      landingPath: '/app/landing_page/chipk',
      defaultQuery: { noReloadApp: '1' },
      defaultExpectedTexts: ['籌碼K線'],
    },
    stockDirectory: [
      { id: '1459', name: '聯發', type: '1' },
      { id: '2025', name: '千興', type: '1' },
      { id: '2324', name: '仁寶', type: '1' },
      { id: '2330', name: '台積電', type: '1' },
      { id: '2454', name: '聯發科', type: '1' },
      { id: '9904', name: '寶成', type: '1' },
    ],
    routes: [
      {
        id: 'stock-health-check',
        page: 'stock',
        subpage: 26,
        name: '個股健檢',
        intentTerms: ['健檢', '健康檢查', '多空評分'],
        requiredParams: [{ name: 'stockid', label: '股票代號', type: 'string' }],
        optionalParams: [{ name: 'stockname', label: '股票名稱', type: 'string' }],
        expectedTexts: ['健檢'],
        contentTexts: ['綜合評語', '交易屬性健診'],
        captureAllowed: true,
        sideEffectRisk: 'none',
      },
      {
        id: 'trade-order',
        page: 'trade',
        subpage: 1,
        name: '下單',
        intentTerms: ['下單', '買進'],
        requiredParams: [],
        optionalParams: [],
        expectedTexts: ['下單'],
        captureAllowed: false,
        sideEffectRisk: 'high',
      },
    ],
  };
}

function syntheticCaptureExec(udid) {
  return (file, args) => {
    if (file === 'xcrun' && args[1] === 'list') {
      return JSON.stringify({
        devices: { runtime: [{ udid, name: 'iPhone Test', state: 'Booted', isAvailable: true }] },
      });
    }
    if (file === 'xcrun' && args[1] === 'get_app_container') return '/tmp/FakeChipK.app';
    if (file === 'plutil') return args[1] === 'CFBundleVersion' ? '100' : '10.0.0';
    if (file === 'tesseract') return 'List of available languages (1):\nchi_tra';
    if (file === 'xcrun' && args[1] === 'openurl') return '';
    if (file === 'xcrun' && args[1] === 'io') {
      fs.writeFileSync(args[4], 'synthetic-png-bytes');
      return '';
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };
}

function syntheticOcrLine(text) {
  return { text, synthetic: true };
}

function geometryOcrLine(words) {
  const x0 = Math.min(...words.map((word) => word.x));
  const y0 = Math.min(...words.map((word) => word.y));
  const x1 = Math.max(...words.map((word) => word.x + word.w));
  const y1 = Math.max(...words.map((word) => word.y + word.h));
  return {
    text: words.map((word) => word.t).join(''),
    words,
    x: x0,
    y: y0,
    w: x1 - x0,
    h: y1 - y0,
  };
}

function stairStepOcrLines() {
  return [
    geometryOcrLine([{ t: '主力', x: 0, y: 500, w: 100, h: 35 }]),
    geometryOcrLine([{ t: '狂收', x: 50, y: 547, w: 100, h: 35 }]),
    geometryOcrLine([{ t: '噴發', x: 100, y: 594, w: 100, h: 35 }]),
  ];
}

function featuredFixtureCatalog() {
  const catalog = fixtureCatalog();
  Object.assign(catalog.routes[0], {
    id: 'featured-main-force',
    page: 'select',
    subpage: 3,
    name: '精選主力策略',
    requiredParams: [],
    optionalParams: [],
    expectedTexts: ['精選', '主力狂收噴發'],
    contentTexts: [],
  });
  return catalog;
}

test('catalog schema 接受固定 ChipK target 與完整 route 欄位', () => {
  assert.deepEqual(validateCatalog(fixtureCatalog()), {
    ok: true,
    schemaVersion: 1,
    routeCount: 2,
  });
});

test('catalog 驗證 optional stockDirectory 欄位與唯一 canonical key', () => {
  const invalid = fixtureCatalog();
  invalid.stockDirectory.push({ id: '2330', name: '另一名稱', type: '1' });
  assert.throws(() => validateCatalog(invalid), /stockDirectory id 重複/);
  const withoutDirectory = fixtureCatalog();
  delete withoutDirectory.stockDirectory;
  assert.equal(validateCatalog(withoutDirectory).ok, true);
});

test('catalog 拒絕被換成任意 scheme 或 host', () => {
  const catalog = fixtureCatalog();
  catalog.product.customScheme = 'evil';
  catalog.product.landingHost = 'example.com';
  assert.throws(
    () => validateCatalog(catalog),
    (error) =>
      error instanceof CliError &&
      error.code === 'catalog_invalid' &&
      /customScheme/.test(error.message) &&
      /landingHost/.test(error.message),
  );
});

test('catalog 拒絕 token 類敏感 query param', () => {
  const catalog = fixtureCatalog();
  catalog.routes[0].optionalParams.push({ name: 'access_token', type: 'string' });
  assert.throws(() => validateCatalog(catalog), /不得宣告敏感參數/);
});

test('catalog 驗證 fixedParams 非空、安全且不與 user params 重複', () => {
  const valid = fixtureCatalog();
  valid.routes[0].fixedParams = { strategyName: '主力狂收噴發' };
  assert.equal(validateCatalog(valid).ok, true);

  const sensitive = fixtureCatalog();
  sensitive.routes[0].fixedParams = { access_token: 'do-not-store' };
  assert.throws(() => validateCatalog(sensitive), /fixedParams 不得含敏感參數/);

  const empty = fixtureCatalog();
  empty.routes[0].fixedParams = { strategyName: '' };
  assert.throws(() => validateCatalog(empty), /必須是非空 primitive/);

  const duplicate = fixtureCatalog();
  duplicate.routes[0].fixedParams = { stockid: '2330' };
  assert.throws(() => validateCatalog(duplicate), /不得與 requiredParams\/optionalParams 重複/);
});

test('catalog 對 root navigation policy fail closed，且禁止 noReloadApp 衝突', () => {
  const valid = fixtureCatalog();
  valid.routes[0].requiresRootNavigation = true;
  assert.equal(validateCatalog(valid).ok, true);

  const invalidType = fixtureCatalog();
  invalidType.routes[0].requiresRootNavigation = 'yes';
  assert.throws(() => validateCatalog(invalidType), /requiresRootNavigation 必須是 boolean/);

  const conflictingFixedParam = fixtureCatalog();
  conflictingFixedParam.routes[0].requiresRootNavigation = true;
  conflictingFixedParam.routes[0].fixedParams = { noReloadApp: '1' };
  assert.throws(
    () => validateCatalog(conflictingFixedParam),
    /requiresRootNavigation 不得同時宣告 noReloadApp/,
  );
});

test('source version 與 catalog version 分開記錄', () => {
  const catalog = fixtureCatalog();
  delete catalog.source;
  catalog.catalogVersion = 'catalog-v2';
  catalog.sources = [
    { kind: 'builder-json', sourceCommit: 'abc123' },
    { kind: 'google-sheet', modifiedAt: '2026-08-19T00:00:00Z' },
  ];
  assert.equal(
    getSourceVersion(catalog),
    'builder-json@abc123|google-sheet@2026-08-19T00:00:00Z',
  );
});

test('每個 command 嚴格拒絕未允許 flag 與拼字錯誤', () => {
  assert.throws(
    () => parseArgs(['plan', '--stock-idd', '2330']),
    (error) => error instanceof CliError && error.code === 'unknown_flag',
  );
  assert.throws(
    () => parseArgs(['catalog-check', '--route', 'chipk.stock.health-check']),
    (error) => error instanceof CliError && error.code === 'unknown_flag',
  );
  assert.throws(
    () => parseArgs(['preflight', '--confirm-vip-session']),
    (error) => error instanceof CliError && error.code === 'unknown_flag',
  );
});

test('noReloadApp 只能由 catalog defaultQuery 加入，CLI flag 不公開', () => {
  assert.throws(
    () => parseArgs(['plan', '--no-reload-app']),
    (error) => error instanceof CliError && error.code === 'unknown_flag',
  );
  const plan = buildPlan(fixtureCatalog(), {
    route: 'stock-health-check',
    mode: 'test',
    stockId: '2330',
  });
  assert.equal(plan.parameters.noReloadApp, '1');
  assert.match(plan.url, /[?&]noReloadApp=1(?:&|$)/);
});

test('requiresRootNavigation 只移除 noReloadApp，並保留其他 catalog defaults', () => {
  const catalog = fixtureCatalog();
  catalog.product.defaultQuery.source = 'capture-test';
  catalog.routes[0].requiresRootNavigation = true;
  const plan = buildPlan(catalog, {
    route: 'stock-health-check',
    mode: 'test',
    stockId: '2330',
  });

  assert.equal(plan.route.requiresRootNavigation, true);
  assert.equal(plan.parameters.noReloadApp, undefined);
  assert.equal(plan.parameters.source, 'capture-test');
  assert.doesNotMatch(plan.url, /[?&]noReloadApp=/);
  assert.match(plan.url, /[?&]source=capture-test(?:&|$)/);
});

test('正式 Featured route 要求 root navigation，其他 route 保留 current stack', () => {
  const catalog = readCatalog();
  const featured = buildPlan(catalog, {
    route: 'chipk.select.featured-main-force',
    mode: 'test',
  });
  const stock = buildPlan(catalog, {
    route: 'chipk.stock.main-force',
    mode: 'test',
    stockId: '2330',
    stockName: '台積電',
  });

  assert.equal(featured.route.requiresRootNavigation, true);
  assert.equal(featured.parameters.noReloadApp, undefined);
  assert.doesNotMatch(featured.url, /[?&]noReloadApp=/);
  assert.equal(stock.route.requiresRootNavigation, false);
  assert.equal(stock.parameters.noReloadApp, '1');
});

test('resolveStock 只以正式名稱或完整 ID deterministic 解析台積電', () => {
  assert.deepEqual(resolveStock(fixtureCatalog(), '這段要拍台積電的健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.deepEqual(resolveStock(fixtureCatalog(), '請看股票代號 2330 的健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.equal(resolveStock(fixtureCatalog(), '請看台積').status, 'unresolved');
});

test('歷史日期不會被當股票 ID，但 stock context 與 canonical name 仍可解析', () => {
  assert.equal(resolveStock(fixtureCatalog(), '2025-01-02 的健檢').status, 'unresolved');
  assert.deepEqual(resolveStock(fixtureCatalog(), '股票代號 2330 的健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.deepEqual(resolveStock(fixtureCatalog(), '2330，股票的健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.deepEqual(resolveStock(fixtureCatalog(), 'stock: 2330 健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.deepEqual(resolveStock(fixtureCatalog(), '2025-01-02 的台積電健檢').resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.deepEqual(resolveStock(fixtureCatalog(), '', { stockid: '2025' }).resolvedParams, {
    stockid: '2025',
    stockname: '千興',
  });
});

test('resolveStock 不猜多股票，並排除較長正式名稱內的短名稱重疊', () => {
  const one = resolveStock(fixtureCatalog(), '請看聯發科健檢');
  assert.equal(one.status, 'resolved');
  assert.equal(one.resolvedParams.stockid, '2454');
  const multiple = resolveStock(fixtureCatalog(), '比較台積電和聯發科');
  assert.equal(multiple.status, 'ambiguous');
  assert.equal(multiple.reason, 'multiple_stocks');
  assert.deepEqual(multiple.candidates.map((stock) => stock.id), ['2330', '2454']);
});

test('canonical name non-overlap 不讓仁寶成交量跨詞誤命中寶成', () => {
  const resolved = resolveStock(fixtureCatalog(), '仁寶成交量放大');
  assert.equal(resolved.status, 'resolved');
  assert.deepEqual(resolved.resolvedParams, { stockid: '2324', stockname: '仁寶' });
});

test('用標點明確並列仁寶、寶成時仍回 multiple stocks', () => {
  const resolved = resolveStock(fixtureCatalog(), '比較仁寶、寶成的成交量');
  assert.equal(resolved.status, 'ambiguous');
  assert.equal(resolved.reason, 'multiple_stocks');
  assert.deepEqual(resolved.candidates.map((stock) => stock.id), ['2324', '9904']);
});

test('resolveStock 明確參數優先，ID/name 衝突直接拒絕', () => {
  const provided = resolveStock(fixtureCatalog(), '文案同時提到聯發科', {
    stockid: '2330',
  });
  assert.equal(provided.source, 'provided');
  assert.deepEqual(provided.resolvedParams, { stockid: '2330', stockname: '台積電' });
  assert.throws(
    () => resolveStock(fixtureCatalog(), '', { stockid: '2330', stockname: '聯發科' }),
    (error) => error instanceof CliError && error.code === 'stock_conflict',
  );
});

test('suggest 只回傳有明確詞彙命中的可截圖 route', () => {
  const result = suggestRoutes(fixtureCatalog(), '這段要介紹台積電的健檢與多空評分');
  assert.equal(result.suggestions.length, 1);
  assert.equal(result.suggestions[0].route, 'stock-health-check');
  assert.equal(result.suggestions[0].routeCaptureAllowed, true);
  assert.equal('captureAllowed' in result.suggestions[0], false);
  assert.deepEqual(result.suggestions[0].matchedTerms, ['健檢', '多空評分']);
  assert.deepEqual(result.suggestions[0].requiredParams, ['stockid']);
  assert.deepEqual(result.suggestions[0].missingParams, []);
  assert.deepEqual(result.suggestions[0].resolvedParams, {
    stockid: '2330',
    stockname: '台積電',
  });
  assert.equal(result.requiresRouteChoice, false);
  assert.equal(result.requiresInput, false);
  assert.equal(result.planReady, true);
  assert.deepEqual(result.unresolvedGates, []);
  assert.equal(result.requiresHumanChoice, false);
  assert.equal(result.requestedScope, 'planning_only');
  assert.equal(result.captureAuthorization, 'not_requested');
});

test('suggest 會從 missingParams 扣除已提供的 route 參數', () => {
  const result = suggestRoutes(fixtureCatalog(), '請拍健檢', 5, { stockid: '2330' });
  assert.deepEqual(result.suggestions[0].requiredParams, ['stockid']);
  assert.deepEqual(result.suggestions[0].missingParams, []);
});

test('suggest unknown 與多股票都停在 machine-readable input gate', () => {
  const unknown = suggestRoutes(fixtureCatalog(), '請拍這檔股票的健檢');
  assert.equal(unknown.requiresRouteChoice, false);
  assert.equal(unknown.requiresInput, true);
  assert.equal(unknown.planReady, false);
  assert.deepEqual(unknown.unresolvedGates, ['stock_not_found']);
  assert.equal(unknown.requiresHumanChoice, true);

  const multiple = suggestRoutes(fixtureCatalog(), '比較台積電和聯發科的健檢');
  assert.equal(multiple.requiresInput, true);
  assert.equal(multiple.planReady, false);
  assert.deepEqual(multiple.unresolvedGates, ['multiple_stocks']);
  assert.equal(multiple.requiresHumanChoice, true);
});

test('live plan 只接受本機今天的 script-date', () => {
  const now = new Date(2026, 7, 19, 12, 0, 0);
  assert.throws(
    () =>
      buildPlan(
        fixtureCatalog(),
        {
          route: 'stock-health-check',
          mode: 'live',
          scriptDate: '2026-08-18',
          stockId: '2330',
          stockName: '台積電',
        },
        now,
      ),
    (error) => error instanceof CliError && error.code === 'stale_script_date',
  );
});

test('test plan 允許歷史 script-date 並產生固定 allowlist URL', () => {
  const plan = buildPlan(fixtureCatalog(), {
    route: 'stock-health-check',
    mode: 'test',
    scriptDate: '2025-01-02',
    stockId: '2330',
    stockName: '台積電',
  });
  assert.equal(plan.dryRun, true);
  assert.equal(plan.requestedScope, 'planning_only');
  assert.equal(plan.nextAction, 'stop_after_plan');
  assert.equal(plan.mode, 'test');
  assert.equal(
    plan.url,
    'chipk://www.cmoney.tw/app/landing_page/chipk?page=stock&subpage=26&stockid=2330&stockname=%E5%8F%B0%E7%A9%8D%E9%9B%BB&noReloadApp=1',
  );
  assert.deepEqual(plan.expectedTexts, ['健檢', '2330']);
  assert.deepEqual(plan.parameters, {
    page: 'stock',
    subpage: '26',
    stockid: '2330',
    stockname: '台積電',
    noReloadApp: '1',
  });
  assert.deepEqual(plan.contentTexts, ['綜合評語', '交易屬性健診', '台積電']);
  assert.equal(plan.planReady, true);
  assert.deepEqual(plan.unresolvedGates, []);
  assert.deepEqual(plan.captureGate, {
    authorization: 'required',
    persona: 'vip',
    sessionConfirmation: 'required',
    nextAction: 'await_capture_authorization',
  });
});

test('buildPlan 將 fixedParams 固定合併到 URL，且不列為 missing', () => {
  const catalog = fixtureCatalog();
  catalog.routes[0].fixedParams = { strategyName: '主力狂收噴發' };
  const plan = buildPlan(catalog, {
    route: 'stock-health-check',
    mode: 'test',
    stockName: '台積電',
  });
  assert.equal(
    plan.url,
    'chipk://www.cmoney.tw/app/landing_page/chipk?page=stock&subpage=26&stockid=2330&stockname=%E5%8F%B0%E7%A9%8D%E9%9B%BB&noReloadApp=1&strategyName=%E4%B8%BB%E5%8A%9B%E7%8B%82%E6%94%B6%E5%99%B4%E7%99%BC',
  );
  assert.equal(plan.parameters.strategyName, '主力狂收噴發');
  const suggestion = suggestRoutes(catalog, '台積電健檢');
  assert.deepEqual(suggestion.suggestions[0].missingParams, []);
});

test('buildPlan 拒絕使用者用 --param 覆寫 fixedParams', () => {
  const catalog = fixtureCatalog();
  catalog.routes[0].fixedParams = { strategyName: '主力狂收噴發' };
  assert.throws(
    () =>
      buildPlan(catalog, {
        route: 'stock-health-check',
        mode: 'test',
        stockName: '台積電',
        params: ['strategyName=另一策略'],
      }),
    (error) => error instanceof CliError && error.code === 'fixed_param_override',
  );
});

test('buildPlan 只給 canonical stockName 時由 directory 補 stock ID', () => {
  const plan = buildPlan(fixtureCatalog(), {
    route: 'stock-health-check',
    mode: 'test',
    stockName: '台積電',
  });
  assert.equal(plan.parameters.stockid, '2330');
  assert.equal(plan.parameters.stockname, '台積電');
  assert.equal(plan.planReady, true);
  assert.deepEqual(plan.unresolvedGates, []);
});

test('股票名稱 OCR 誤字不阻擋 route label + exact ID readiness', () => {
  const catalog = fixtureCatalog();
  Object.assign(catalog.routes[0], {
    id: 'stock-main-force',
    name: '主力',
    subpage: 5,
    intentTerms: ['主力'],
    expectedTexts: ['主力'],
    contentTexts: [],
  });
  const plan = buildPlan(catalog, {
    route: 'stock-main-force',
    mode: 'test',
    stockName: '仁寶',
  });
  assert.deepEqual(plan.expectedTexts, ['主力', '2324']);
  assert.deepEqual(plan.contentTexts, ['仁寶']);
  assert.deepEqual(
    matchedExpectedTexts(
      [syntheticOcrLine('仁賣 2324'), syntheticOcrLine('主力進出')],
      plan.expectedTexts,
    ),
    { matched: ['主力', '2324'], missing: [] },
  );
  assert.deepEqual(
    matchedExpectedTexts(
      [syntheticOcrLine('仁賣 2324'), syntheticOcrLine('主力進出')],
      plan.contentTexts,
    ),
    { matched: [], missing: ['仁寶'] },
  );
});

test('理論上的 name-only stock route 仍以名稱作 identity readiness', () => {
  const catalog = fixtureCatalog();
  catalog.routes[0].requiredParams = [{ name: 'stockname', type: 'string' }];
  catalog.routes[0].optionalParams = [];
  const plan = buildPlan(catalog, {
    route: 'stock-health-check',
    mode: 'test',
    stockName: '台積電',
  });
  assert.equal(plan.parameters.stockid, undefined);
  assert.deepEqual(plan.expectedTexts, ['健檢', '台積電']);
  assert.deepEqual(plan.contentTexts, ['綜合評語', '交易屬性健診']);
});

test('buildPlan 拒絕明確 ID/name conflict', () => {
  assert.throws(
    () =>
      buildPlan(fixtureCatalog(), {
        route: 'stock-health-check',
        mode: 'test',
        stockId: '2330',
        stockName: '聯發科',
      }),
    (error) => error instanceof CliError && error.code === 'stock_conflict',
  );
});

test('test plan 可省略 script-date，但不得缺 route 必要參數', () => {
  assert.throws(
    () =>
      buildPlan(fixtureCatalog(), {
        route: 'stock-health-check',
        mode: 'test',
      }),
    (error) => error instanceof CliError && error.code === 'missing_param',
  );
});

test('plan 拒絕 catalog 未允許的 query param 與禁止截圖 route', () => {
  assert.throws(
    () =>
      buildPlan(fixtureCatalog(), {
        route: 'stock-health-check',
        mode: 'test',
        stockId: '2330',
        stockName: '台積電',
        params: ['redirect=https://example.com'],
      }),
    (error) => error instanceof CliError && error.code === 'param_not_allowed',
  );
  assert.throws(
    () => buildPlan(fixtureCatalog(), { route: 'trade-order', mode: 'test' }),
    (error) => error instanceof CliError && error.code === 'capture_not_allowed',
  );
});

test('plan 即使 captureAllowed 也拒絕 sideEffectRisk 不為 none 的 route', () => {
  const catalog = fixtureCatalog();
  catalog.routes[1].captureAllowed = true;
  assert.throws(
    () => buildPlan(catalog, { route: 'trade-order', mode: 'test' }),
    (error) => error instanceof CliError && error.code === 'side_effect_risk',
  );
});

test('preflight device resolution 必須 exact UDID，不任取 booted device', () => {
  const devices = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { udid: '11111111-1111-1111-1111-111111111111', name: 'iPhone A', state: 'Booted' },
        { udid: '22222222-2222-2222-2222-222222222222', name: 'iPhone B', state: 'Booted' },
      ],
    },
  };
  assert.equal(
    exactSimulator(devices, '22222222-2222-2222-2222-222222222222').name,
    'iPhone B',
  );
  assert.throws(
    () => exactSimulator(devices, '33333333-3333-3333-3333-333333333333'),
    (error) => error instanceof CliError && error.code === 'simulator_not_found',
  );
});

test('OCR 驗證忽略空白與標點，但要求所有 expectedTexts', () => {
  const match = matchedExpectedTexts(
    [syntheticOcrLine('台 積 電（2330）'), syntheticOcrLine('綜合 健檢')],
    ['台積電', '健檢'],
  );
  assert.deepEqual(match, { matched: ['台積電', '健檢'], missing: [] });
  assert.deepEqual(
    matchedExpectedTexts([syntheticOcrLine('台積電')], ['台積電', '健檢']).missing,
    ['健檢'],
  );
});

test('default/PSM6 OCR 只匹配有 geometry 的同列連續 word clusters', () => {
  const contiguous = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 181, y: 402, w: 72, h: 33 },
  ]);
  const oneWord = geometryOcrLine([
    { t: '精選', x: 24, y: 300, w: 72, h: 35 },
  ]);
  const adjacentColumns = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 260, y: 402, w: 72, h: 33 },
  ]);

  assert.deepEqual(
    matchedExpectedTexts([contiguous, oneWord], ['精選', '主力狂收噴發']),
    { matched: ['精選', '主力狂收噴發'], missing: [] },
  );
  assert.deepEqual(
    matchedExpectedTexts([adjacentColumns], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedExpectedTexts([{ text: '主力狂收噴發' }], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedExpectedTexts([
      { text: '主力狂收噴發', words: [{ t: '主力狂收噴發', x: 24, y: 400, w: 0, h: 35 }] },
    ], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
});

test('PSM11 只以有 bounding box 的 word clusters 作單行與垂直 wrapped 候選', () => {
  const oneWord = geometryOcrLine([
    { t: '精選', x: 24, y: 300, w: 72, h: 35 },
  ]);
  const contiguous = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 181, y: 402, w: 72, h: 33 },
  ]);
  const twoLineWrapped = [
    geometryOcrLine([{ t: '主力狂收', x: 24, y: 500, w: 150, h: 35 }]),
    geometryOcrLine([{ t: '噴發', x: 63, y: 547, w: 72, h: 35 }]),
  ];
  const threeLineWrapped = [
    geometryOcrLine([{ t: '主力', x: 24, y: 600, w: 70, h: 35 }]),
    geometryOcrLine([{ t: '狂收', x: 30, y: 647, w: 80, h: 35 }]),
    geometryOcrLine([{ t: '噴發', x: 36, y: 694, w: 72, h: 35 }]),
  ];
  const stairStep = stairStepOcrLines();
  const groupedAdjacentColumns = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 260, y: 402, w: 72, h: 33 },
  ]);

  assert.deepEqual(
    matchedSparseExpectedTexts([oneWord, contiguous], ['精選', '主力狂收噴發']),
    { matched: ['精選', '主力狂收噴發'], missing: [] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts(twoLineWrapped, ['主力狂收噴發']),
    { matched: ['主力狂收噴發'], missing: [] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts(threeLineWrapped, ['主力狂收噴發']),
    { matched: ['主力狂收噴發'], missing: [] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts(stairStep, ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts([groupedAdjacentColumns], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts([{ text: '主力狂收噴發' }], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts([syntheticOcrLine('主力狂收噴發')], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
  assert.deepEqual(
    matchedSparseExpectedTexts([
      { text: '主力狂收噴發', words: [{ t: '主力狂收噴發', x: 24, y: 400, w: 0, h: 35 }] },
    ], ['主力狂收噴發']),
    { matched: [], missing: ['主力狂收噴發'] },
  );
});

test('default/PSM6 OCR 每個 expected text 只在單一 line 內匹配', () => {
  const negative = ocrGeometryFixture.cases.find(
    (fixture) => fixture.id === 'wrong-tab-fragments-in-adjacent-columns',
  );
  assert.deepEqual(
    matchedExpectedTexts(
      negative.sparseLines.map((line) => ({ ...line, synthetic: true })),
      negative.expectedTexts,
    ),
    { matched: [], missing: negative.expectedTexts },
  );
});

test('sparse OCR 只串接同欄垂直相鄰 fragments，不跨相鄰欄誤判', () => {
  for (const fixture of ocrGeometryFixture.cases) {
    const match = matchedSparseExpectedTexts(fixture.sparseLines, fixture.expectedTexts);
    assert.deepEqual(match.matched, fixture.expectedMatched, fixture.id);
    assert.deepEqual(
      match.missing,
      fixture.expectedTexts.filter((text) => !fixture.expectedMatched.includes(text)),
      fixture.id,
    );
    if (fixture.contentTexts) {
      const contentMatch = matchedSparseExpectedTexts(fixture.sparseLines, fixture.contentTexts);
      assert.deepEqual(contentMatch.matched, fixture.expectedContentMatched, fixture.id);
      assert.deepEqual(
        contentMatch.missing,
        fixture.contentTexts.filter((text) => !fixture.expectedContentMatched.includes(text)),
        fixture.id,
      );
    }
  }
});

test('capture 在 default OCR 已命中時不執行任何 fallback', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-default-ocr-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const ocrCalls = [];

  const result = await captureRoute(
    fixtureCatalog(),
    {
      route: 'stock-health-check',
      mode: 'test',
      stockId: '2330',
      stockName: '台積電',
      udid,
      output: path.join(tempDir, 'capture.png'),
      manifest: path.join(tempDir, 'capture.json'),
      confirmVipSession: true,
    },
    {
      exec: syntheticCaptureExec(udid),
      ocrLines: (_file, lang, options) => {
        ocrCalls.push({ lang, options });
        return [syntheticOcrLine('綜合健檢 2330 綜合評語 交易屬性健診 台積電')];
      },
      now: () => new Date(2026, 7, 19),
    },
  );

  assert.deepEqual(ocrCalls, [{ lang: 'chi_tra', options: undefined }]);
  assert.deepEqual(result.verification.ocrReadiness, {
    modesTried: ['default'],
    sparseFallbackAttempted: false,
    spatialStrategy: null,
    resolvedBy: 'default',
    pollAttemptCount: 1,
    ocrCallCount: 1,
  });
});

test('capture 單次 PSM11 驗 wrapped readiness/content 且拒絕 adjacent-column content', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-sparse-ocr-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const ocrCalls = [];
  const catalog = featuredFixtureCatalog();
  const positive = ocrGeometryFixture.cases.find(
    (fixture) => fixture.id === 'wrapped-target-with-adjacent-column',
  );
  catalog.routes[0].contentTexts = positive.contentTexts;

  const result = await captureRoute(
    catalog,
    {
      route: 'featured-main-force',
      mode: 'test',
      udid,
      output: path.join(tempDir, 'capture.png'),
      manifest: path.join(tempDir, 'capture.json'),
      confirmVipSession: true,
    },
    {
      exec: syntheticCaptureExec(udid),
      ocrLines: (_file, lang, options) => {
        ocrCalls.push({ lang, options });
        return options?.psm === 11 ? positive.sparseLines : [syntheticOcrLine('精選')];
      },
      now: () => new Date(2026, 7, 19),
    },
  );

  assert.deepEqual(ocrCalls, [
    { lang: 'chi_tra', options: undefined },
    { lang: 'chi_tra', options: { psm: 6 } },
    { lang: 'chi_tra', options: { psm: 11 } },
  ]);
  assert.deepEqual(result.verification.matchedTexts, ['精選', '主力狂收噴發']);
  assert.deepEqual(result.verification.contentTexts, {
    expected: positive.contentTexts,
    observed: positive.expectedContentMatched,
    missing: positive.contentTexts.filter(
      (text) => !positive.expectedContentMatched.includes(text),
    ),
  });
  assert.deepEqual(result.verification.ocrReadiness, {
    modesTried: ['default', 'psm6', 'psm11'],
    sparseFallbackAttempted: true,
    spatialStrategy: 'word_cluster_chain_start_alignment_v4',
    resolvedBy: 'psm11_spatial',
    pollAttemptCount: 1,
    ocrCallCount: 3,
  });
});

test('capture readiness 由 default/PSM6 解決時只補一次 PSM11 content fallback', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-content-ocr-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const positive = ocrGeometryFixture.cases.find(
    (fixture) => fixture.id === 'wrapped-target-with-adjacent-column',
  );

  for (const readinessStage of ['default', 'psm6']) {
    const catalog = fixtureCatalog();
    catalog.routes[0].contentTexts = positive.contentTexts;
    const ocrCalls = [];
    const result = await captureRoute(
      catalog,
      {
        route: 'stock-health-check',
        mode: 'test',
        stockId: '2330',
        stockName: '台積電',
        udid,
        output: path.join(tempDir, `${readinessStage}.png`),
        manifest: path.join(tempDir, `${readinessStage}.json`),
        confirmVipSession: true,
      },
      {
        exec: syntheticCaptureExec(udid),
        ocrLines: (_file, lang, options) => {
          ocrCalls.push({ lang, options });
          if (options?.psm === 11) return positive.sparseLines;
          if (options?.psm === 6) return [syntheticOcrLine('2330')];
          return [syntheticOcrLine(
            readinessStage === 'default'
              ? '綜合健檢 2330 台積電'
              : '綜合健檢 台積電',
          )];
        },
        now: () => new Date(2026, 7, 19),
      },
    );

    assert.deepEqual(result.verification.contentTexts, {
      expected: [...positive.contentTexts, '台積電'],
      observed: [...positive.expectedContentMatched, '台積電'],
      missing: ['相鄰內容'],
    }, readinessStage);
    assert.deepEqual(result.verification.ocrReadiness, {
      modesTried: readinessStage === 'default'
        ? ['default', 'psm11']
        : ['default', 'psm6', 'psm11'],
      sparseFallbackAttempted: true,
      spatialStrategy: 'word_cluster_chain_start_alignment_v4',
      resolvedBy: readinessStage,
      pollAttemptCount: 1,
      ocrCallCount: readinessStage === 'default' ? 2 : 3,
    }, readinessStage);
    assert.equal(
      ocrCalls.filter((call) => call.options?.psm === 11).length,
      1,
      readinessStage,
    );
  }
});

test('capture 的 PSM11 adjacent-column fragments 不得通過且零發布', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-sparse-negative-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const output = path.join(tempDir, 'capture.png');
  const manifest = path.join(tempDir, 'capture.json');
  const ocrCalls = [];
  const clockValues = [0, 0, 2000];
  const negative = ocrGeometryFixture.cases.find(
    (fixture) => fixture.id === 'wrong-tab-fragments-in-adjacent-columns',
  );

  await assert.rejects(
    () => captureRoute(
      featuredFixtureCatalog(),
      {
        route: 'featured-main-force',
        mode: 'test',
        udid,
        output,
        manifest,
        timeoutMs: 1000,
        pollMs: 250,
        confirmVipSession: true,
      },
      {
        exec: syntheticCaptureExec(udid),
        ocrLines: (_file, lang, options) => {
          ocrCalls.push({ lang, options });
          return options?.psm === 11 ? negative.sparseLines : [syntheticOcrLine('精選')];
        },
        sleep: async () => {},
        clock: () => clockValues.shift() ?? 2000,
        now: () => new Date(2026, 7, 19),
      },
    ),
    (error) => error instanceof CliError && error.code === 'expected_text_timeout',
  );

  assert.deepEqual(ocrCalls, [
    { lang: 'chi_tra', options: undefined },
    { lang: 'chi_tra', options: { psm: 6 } },
    { lang: 'chi_tra', options: { psm: 11 } },
  ]);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(manifest), false);
});

test('capture 的 PSM11 單一 TSV line 跨欄 words 不得通過且零發布', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-psm11-line-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const output = path.join(tempDir, 'capture.png');
  const manifest = path.join(tempDir, 'capture.json');
  const ocrCalls = [];
  const clockValues = [0, 0, 2000];
  const groupedAdjacentLine = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 260, y: 402, w: 72, h: 33 },
  ]);
  assert.equal(groupedAdjacentLine.text, '主力狂收噴發');

  await assert.rejects(
    () => captureRoute(
      featuredFixtureCatalog(),
      {
        route: 'featured-main-force',
        mode: 'test',
        udid,
        output,
        manifest,
        timeoutMs: 1000,
        pollMs: 250,
        confirmVipSession: true,
      },
      {
        exec: syntheticCaptureExec(udid),
        ocrLines: (_file, lang, options) => {
          ocrCalls.push({ lang, options });
          return options?.psm === 11
            ? [groupedAdjacentLine]
            : [syntheticOcrLine('精選')];
        },
        sleep: async () => {},
        clock: () => clockValues.shift() ?? 2000,
        now: () => new Date(2026, 7, 19),
      },
    ),
    (error) => error instanceof CliError && error.code === 'expected_text_timeout',
  );

  assert.deepEqual(ocrCalls, [
    { lang: 'chi_tra', options: undefined },
    { lang: 'chi_tra', options: { psm: 6 } },
    { lang: 'chi_tra', options: { psm: 11 } },
  ]);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(manifest), false);
});

test('capture 的 PSM11 三行 stair-step fragments 不得通過且零發布', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-psm11-chain-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const output = path.join(tempDir, 'capture.png');
  const manifest = path.join(tempDir, 'capture.json');
  const ocrCalls = [];
  const clockValues = [0, 0, 2000];

  await assert.rejects(
    () => captureRoute(
      featuredFixtureCatalog(),
      {
        route: 'featured-main-force',
        mode: 'test',
        udid,
        output,
        manifest,
        timeoutMs: 1000,
        pollMs: 250,
        confirmVipSession: true,
      },
      {
        exec: syntheticCaptureExec(udid),
        ocrLines: (_file, lang, options) => {
          ocrCalls.push({ lang, options });
          return options?.psm === 11
            ? stairStepOcrLines()
            : [syntheticOcrLine('精選')];
        },
        sleep: async () => {},
        clock: () => clockValues.shift() ?? 2000,
        now: () => new Date(2026, 7, 19),
      },
    ),
    (error) => error instanceof CliError && error.code === 'expected_text_timeout',
  );

  assert.deepEqual(ocrCalls, [
    { lang: 'chi_tra', options: undefined },
    { lang: 'chi_tra', options: { psm: 6 } },
    { lang: 'chi_tra', options: { psm: 11 } },
  ]);
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.existsSync(manifest), false);
});

test('capture 的 default/PSM6 單一 TSV line 跨欄 fragments 不得通過且零發布', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-dense-negative-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const udid = '11111111-1111-1111-1111-111111111111';
  const groupedAdjacentLine = geometryOcrLine([
    { t: '主力狂收', x: 24, y: 400, w: 150, h: 35 },
    { t: '噴發', x: 260, y: 402, w: 72, h: 33 },
  ]);
  assert.equal(groupedAdjacentLine.text, '主力狂收噴發');

  for (const stage of ['default', 'psm6']) {
    const output = path.join(tempDir, `${stage}.png`);
    const manifest = path.join(tempDir, `${stage}.json`);
    const ocrCalls = [];
    const clockValues = [0, 0, 2000];

    await assert.rejects(
      () => captureRoute(
        featuredFixtureCatalog(),
        {
          route: 'featured-main-force',
          mode: 'test',
          udid,
          output,
          manifest,
          timeoutMs: 1000,
          pollMs: 250,
          confirmVipSession: true,
        },
        {
          exec: syntheticCaptureExec(udid),
          ocrLines: (_file, lang, options) => {
            ocrCalls.push({ lang, options });
            if (options?.psm === 11) return [];
            if (stage === 'default' && options === undefined) {
              return [syntheticOcrLine('精選'), groupedAdjacentLine];
            }
            if (stage === 'psm6' && options?.psm === 6) return [groupedAdjacentLine];
            return [syntheticOcrLine('精選')];
          },
          sleep: async () => {},
          clock: () => clockValues.shift() ?? 2000,
          now: () => new Date(2026, 7, 19),
        },
      ),
      (error) => error instanceof CliError && error.code === 'expected_text_timeout',
      stage,
    );

    assert.deepEqual(ocrCalls, [
      { lang: 'chi_tra', options: undefined },
      { lang: 'chi_tra', options: { psm: 6 } },
      { lang: 'chi_tra', options: { psm: 11 } },
    ], stage);
    assert.equal(fs.existsSync(output), false, stage);
    assert.equal(fs.existsSync(manifest), false, stage);
  }
});

test('capture 只在 OCR 通過後寫入 PNG 與不含 token 的 manifest', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'capture.png');
  const manifestPath = path.join(tempDir, 'capture.json');
  const udid = '11111111-1111-1111-1111-111111111111';
  const openedUrls = [];
  const fakePng = Buffer.from('fake-png-for-unit-test');
  const ocrCalls = [];
  const catalog = fixtureCatalog();
  catalog.routes[0].requiresRootNavigation = true;
  let tick = 0;
  const exec = (file, args) => {
    if (file === 'xcrun' && args[1] === 'list') {
      return JSON.stringify({
        devices: {
          runtime: [{ udid, name: 'iPhone Test', state: 'Booted', isAvailable: true }],
        },
      });
    }
    if (file === 'xcrun' && args[1] === 'get_app_container') return '/tmp/FakeChipK.app';
    if (file === 'plutil') return args[1] === 'CFBundleVersion' ? '100' : '10.0.0';
    if (file === 'tesseract') return 'List of available languages (1):\nchi_tra';
    if (file === 'xcrun' && args[1] === 'openurl') {
      openedUrls.push(args[3]);
      return '';
    }
    if (file === 'xcrun' && args[1] === 'io') {
      fs.writeFileSync(args[4], fakePng);
      return '';
    }
    throw new Error(`unexpected command: ${file} ${args.join(' ')}`);
  };

  const result = await captureRoute(
    catalog,
    {
      route: 'stock-health-check',
      mode: 'test',
      stockId: '2330',
      stockName: '台積電',
      udid,
      output,
      manifest: manifestPath,
      confirmVipSession: true,
    },
    {
      exec,
      ocrLines: (_file, lang, options) => {
        ocrCalls.push({ lang, options });
        return options?.psm === 6
          ? [syntheticOcrLine('台積賣 2330')]
          : [syntheticOcrLine('綜合健檢與綜合評語交易屬性健診台積電')];
      },
      sleep: async () => {},
      clock: () => (tick += 100),
      now: () => new Date(2026, 7, 19),
    },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(ocrCalls, [
    { lang: 'chi_tra', options: undefined },
    { lang: 'chi_tra', options: { psm: 6 } },
  ]);
  assert.equal(openedUrls.length, 1);
  assert.doesNotMatch(openedUrls[0], /[?&]noReloadApp=/);
  assert.equal(fs.readFileSync(output).equals(fakePng), true);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.route.id, 'stock-health-check');
  assert.equal(manifest.route.requiresRootNavigation, true);
  assert.equal(manifest.resolvedUrl, openedUrls[0]);
  assert.equal(manifest.parameters.stockid, '2330');
  assert.deepEqual(manifest.bundle, { id: 'CMoney.Chipk', version: '10.0.0', build: '100' });
  assert.equal(manifest.device.name, 'iPhone Test');
  assert.equal(manifest.ocr.language, 'chi_tra');
  assert.equal(manifest.catalogVersion, null);
  assert.equal(manifest.sourceVersion, 'fixture-v1');
  assert.deepEqual(manifest.verification.contentTexts, {
    expected: ['綜合評語', '交易屬性健診', '台積電'],
    observed: ['綜合評語', '交易屬性健診', '台積電'],
    missing: [],
  });
  assert.equal(
    manifest.screenshot.sha256,
    crypto.createHash('sha256').update(fakePng).digest('hex'),
  );
  assert.equal(/token/i.test(JSON.stringify(manifest)), false);
});

test('capture 在任何 Simulator 操作前拒絕覆寫既有檔案', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-overwrite-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const output = path.join(tempDir, 'existing.png');
  fs.writeFileSync(output, 'keep-me');
  await assert.rejects(
    () =>
      captureRoute(fixtureCatalog(), {
        route: 'stock-health-check',
        mode: 'test',
        stockId: '2330',
        stockName: '台積電',
        udid: '11111111-1111-1111-1111-111111111111',
        output,
        manifest: path.join(tempDir, 'new.json'),
        confirmVipSession: true,
      }),
    (error) => error instanceof CliError && error.code === 'output_exists',
  );
  assert.equal(fs.readFileSync(output, 'utf8'), 'keep-me');
});

test('capture 未顯式確認 VIP session 時，在任何 simctl 前拒絕', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'simulator-capture-vip-gate-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  let execCount = 0;
  await assert.rejects(
    () =>
      captureRoute(
        fixtureCatalog(),
        {
          route: 'stock-health-check',
          mode: 'test',
          stockId: '2330',
          stockName: '台積電',
          udid: '11111111-1111-1111-1111-111111111111',
          output: path.join(tempDir, 'new.png'),
          manifest: path.join(tempDir, 'new.json'),
        },
        { exec: () => (execCount += 1) },
      ),
    (error) => error instanceof CliError && error.code === 'vip_session_confirmation_required',
  );
  assert.equal(execCount, 0);
});
