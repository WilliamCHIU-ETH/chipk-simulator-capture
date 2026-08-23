#!/usr/bin/env node

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { ocrLines } = require('./app-locator');

const CATALOG_PATH = path.join(__dirname, '..', 'config', 'simulator-capture.catalog.json');
const ALLOWED_TARGET = Object.freeze({
  customScheme: 'chipk',
  landingHost: 'www.cmoney.tw',
  landingPath: '/app/landing_page/chipk',
});
const SENSITIVE_NAME = /(access[-_]?token|token|secret|password|passwd|authorization|cookie|session)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UDID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class CliError extends Error {
  constructor(message, code = 'invalid_request', details = undefined) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.details = details;
  }
}

function readCatalog(catalogPath = CATALOG_PATH) {
  let raw;
  try {
    raw = fs.readFileSync(catalogPath, 'utf8');
  } catch (error) {
    throw new CliError(`找不到 Deep Link catalog：${catalogPath}`, 'catalog_missing');
  }
  let catalog;
  try {
    catalog = JSON.parse(raw);
  } catch (error) {
    throw new CliError(`Deep Link catalog 不是有效 JSON：${error.message}`, 'catalog_invalid_json');
  }
  validateCatalog(catalog);
  return catalog;
}

function validateCatalog(catalog) {
  const errors = [];
  const expectObject = (value, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) errors.push(`${label} 必須是 object`);
  };
  const expectString = (value, label) => {
    if (typeof value !== 'string' || value.trim() === '') errors.push(`${label} 必須是非空字串`);
  };
  const expectStringArray = (value, label, { allowEmpty = true } = {}) => {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
      errors.push(`${label} 必須是${allowEmpty ? '' : '非空'}字串陣列`);
      return;
    }
    value.forEach((item, index) => expectString(item, `${label}[${index}]`));
  };
  const expectParamArray = (value, label) => {
    if (!Array.isArray(value)) {
      errors.push(`${label} 必須是參數陣列`);
      return;
    }
    value.forEach((item, index) => {
      if (typeof item === 'string') {
        expectString(item, `${label}[${index}]`);
        return;
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${label}[${index}] 必須是字串或含 name 的 object`);
        return;
      }
      expectString(item.name, `${label}[${index}].name`);
      if (item.type !== undefined) expectString(item.type, `${label}[${index}].type`);
    });
  };

  expectObject(catalog, 'catalog');
  if (!catalog || typeof catalog !== 'object') throw new CliError(errors.join('；'), 'catalog_invalid');
  if (catalog.schemaVersion !== 1) errors.push('schemaVersion 必須是 1');
  expectObject(catalog.product, 'product');
  if (catalog.product && typeof catalog.product === 'object') {
    expectString(catalog.product.bundleId, 'product.bundleId');
    expectString(catalog.product.customScheme, 'product.customScheme');
    expectString(catalog.product.landingHost, 'product.landingHost');
    expectString(catalog.product.landingPath, 'product.landingPath');
    expectStringArray(catalog.product.defaultExpectedTexts, 'product.defaultExpectedTexts');
    if (catalog.product.defaultQuery !== undefined) {
      expectObject(catalog.product.defaultQuery, 'product.defaultQuery');
      for (const [key, value] of Object.entries(catalog.product.defaultQuery || {})) {
        expectString(key, 'product.defaultQuery key');
        expectString(value, `product.defaultQuery.${key}`);
        if (SENSITIVE_NAME.test(key)) errors.push(`product.defaultQuery 不得含敏感參數：${key}`);
      }
    }
    for (const [key, expected] of Object.entries(ALLOWED_TARGET)) {
      if (catalog.product[key] !== expected) {
        errors.push(`product.${key} 必須固定為 ${JSON.stringify(expected)}`);
      }
    }
  }

  if (catalog.stockDirectory !== undefined) {
    if (!Array.isArray(catalog.stockDirectory)) {
      errors.push('stockDirectory 必須是陣列');
    } else {
      const stockIds = new Set();
      const stockNames = new Set();
      catalog.stockDirectory.forEach((stock, index) => {
        const label = `stockDirectory[${index}]`;
        expectObject(stock, label);
        if (!stock || typeof stock !== 'object') return;
        expectString(stock.id, `${label}.id`);
        expectString(stock.name, `${label}.name`);
        expectString(stock.type, `${label}.type`);
        if (stockIds.has(stock.id)) errors.push(`stockDirectory id 重複：${stock.id}`);
        if (stockNames.has(stock.name)) errors.push(`stockDirectory name 重複：${stock.name}`);
        stockIds.add(stock.id);
        stockNames.add(stock.name);
      });
    }
  }

  if (!Array.isArray(catalog.routes) || catalog.routes.length === 0) {
    errors.push('routes 必須是非空陣列');
  } else {
    const ids = new Set();
    catalog.routes.forEach((route, index) => {
      const label = `routes[${index}]`;
      expectObject(route, label);
      if (!route || typeof route !== 'object') return;
      expectString(route.id, `${label}.id`);
      expectString(route.page, `${label}.page`);
      if (!['string', 'number'].includes(typeof route.subpage) || String(route.subpage).trim() === '') {
        errors.push(`${label}.subpage 必須是非空字串或數字`);
      }
      expectString(route.name, `${label}.name`);
      expectStringArray(route.intentTerms, `${label}.intentTerms`, { allowEmpty: false });
      expectParamArray(route.requiredParams, `${label}.requiredParams`);
      expectParamArray(route.optionalParams, `${label}.optionalParams`);
      if (route.fixedParams !== undefined) expectObject(route.fixedParams, `${label}.fixedParams`);
      expectStringArray(route.expectedTexts, `${label}.expectedTexts`);
      if (route.contentTexts !== undefined) {
        expectStringArray(route.contentTexts, `${label}.contentTexts`);
      }
      if (
        route.requiresRootNavigation !== undefined &&
        typeof route.requiresRootNavigation !== 'boolean'
      ) {
        errors.push(`${label}.requiresRootNavigation 必須是 boolean`);
      }
      if (typeof route.captureAllowed !== 'boolean') errors.push(`${label}.captureAllowed 必須是 boolean`);
      expectString(route.sideEffectRisk, `${label}.sideEffectRisk`);

      if (ids.has(route.id)) errors.push(`route id 重複：${route.id}`);
      ids.add(route.id);
      const required = Array.isArray(route.requiredParams) ? route.requiredParams : [];
      const optional = Array.isArray(route.optionalParams) ? route.optionalParams : [];
      const seenParams = new Set();
      for (const spec of [...required, ...optional]) {
        const name = typeof spec === 'string' ? spec : spec?.name;
        if (typeof name !== 'string') continue;
        if (SENSITIVE_NAME.test(name)) errors.push(`${label} 不得宣告敏感參數：${name}`);
        if (seenParams.has(name)) errors.push(`${label} 參數重複：${name}`);
        seenParams.add(name);
      }
      for (const [name, value] of Object.entries(route.fixedParams || {})) {
        expectString(name, `${label}.fixedParams key`);
        if (
          value === null ||
          !['string', 'number', 'boolean'].includes(typeof value) ||
          String(value).trim() === ''
        ) {
          errors.push(`${label}.fixedParams.${name} 必須是非空 primitive`);
        }
        if (SENSITIVE_NAME.test(name)) errors.push(`${label}.fixedParams 不得含敏感參數：${name}`);
        if (seenParams.has(name)) {
          errors.push(`${label}.fixedParams 不得與 requiredParams/optionalParams 重複：${name}`);
        }
        if (name === 'page' || name === 'subpage') {
          errors.push(`${label}.fixedParams 不得覆寫 reserved 參數：${name}`);
        }
      }
      if (
        route.requiresRootNavigation === true &&
        (seenParams.has('noReloadApp') || Object.hasOwn(route.fixedParams || {}, 'noReloadApp'))
      ) {
        errors.push(`${label}.requiresRootNavigation 不得同時宣告 noReloadApp`);
      }
    });
  }

  if (errors.length > 0) throw new CliError(errors.join('；'), 'catalog_invalid', { errors });
  return { ok: true, schemaVersion: 1, routeCount: catalog.routes.length };
}

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function assertCalendarDate(value, label = 'script-date') {
  if (!DATE_RE.test(value || '')) throw new CliError(`${label} 必須是 YYYY-MM-DD`, 'invalid_date');
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(year, month - 1, day);
  if (
    parsed.getFullYear() !== year ||
    parsed.getMonth() !== month - 1 ||
    parsed.getDate() !== day
  ) {
    throw new CliError(`${label} 不是有效日期：${value}`, 'invalid_date');
  }
}

function normalizeForMatch(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase('zh-Hant-TW')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

function explicitStockValue(provided, lowerKey, camelKey) {
  const values = [provided?.[lowerKey], provided?.[camelKey]]
    .filter((value) => value !== undefined)
    .map(String);
  if (new Set(values).size > 1) {
    throw new CliError(`明確提供的 ${lowerKey} 互相衝突`, 'stock_conflict');
  }
  return values[0];
}

function stockTextMatches(directory, text) {
  const source = String(text || '');
  const occurrences = [];
  for (const stock of directory) {
    let start = source.indexOf(stock.name);
    while (start >= 0) {
      occurrences.push({ stock, start, end: start + stock.name.length });
      start = source.indexOf(stock.name, start + 1);
    }
  }
  occurrences.sort(
    (a, b) =>
      a.start - b.start ||
      (b.end - b.start) - (a.end - a.start) ||
      a.stock.id.localeCompare(b.stock.id),
  );
  const canonicalNameMatches = [];
  for (const candidate of occurrences) {
    const overlaps = canonicalNameMatches.some(
      (selected) => candidate.start < selected.end && selected.start < candidate.end,
    );
    if (!overlaps) canonicalNameMatches.push(candidate);
  }
  const matched = new Map(canonicalNameMatches.map(({ stock }) => [stock.id, stock]));
  const stockContext = '(?:股票代號|個股代號|股票|個股|代號|股號|stock)';
  const contextSeparator = '[\\s\\p{P}\\p{S}]{0,8}';
  const contextualIdPattern = new RegExp(
    `(?:${stockContext}${contextSeparator}(?<after>[0-9A-Za-z]+)(?=$|[^0-9A-Za-z])|` +
      `(?:^|[^0-9A-Za-z])(?<before>[0-9A-Za-z]+)${contextSeparator}${stockContext})`,
    'giu',
  );
  const stocksById = new Map(directory.map((stock) => [stock.id, stock]));
  for (const occurrence of source.matchAll(contextualIdPattern)) {
    const candidateId = occurrence.groups.after || occurrence.groups.before;
    const stock = stocksById.get(candidateId);
    if (stock) matched.set(stock.id, stock);
  }
  return [...matched.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * 只接受 stockDirectory 的正式名稱或完整代號，不做簡稱、錯字或相似度推測。
 * 明確參數優先於 text；明確 ID/name 不一致時直接拒絕。
 */
function resolveStockValidated(catalog, text = '', provided = {}) {
  if (text && typeof text === 'object' && !Array.isArray(text)) {
    provided = text;
    text = '';
  }
  const directory = catalog.stockDirectory || [];
  const stockId = explicitStockValue(provided, 'stockid', 'stockId');
  const stockName = explicitStockValue(provided, 'stockname', 'stockName');
  const hasProvided = stockId !== undefined || stockName !== undefined;

  if (hasProvided) {
    const byId = stockId === undefined ? null : directory.filter((stock) => stock.id === stockId);
    const byName = stockName === undefined ? null : directory.filter((stock) => stock.name === stockName);
    if ((byId && byId.length !== 1) || (byName && byName.length !== 1)) {
      throw new CliError(
        `stockDirectory 找不到明確提供的股票：${stockId || stockName}`,
        'stock_not_found',
      );
    }
    const resolved = byId?.[0] || byName?.[0];
    if (byId && byName && byId[0].id !== byName[0].id) {
      throw new CliError(
        `stockid=${stockId} 與 stockname=${stockName} 指向不同股票`,
        'stock_conflict',
        { byId: byId[0], byName: byName[0] },
      );
    }
    return {
      status: 'resolved',
      source: 'provided',
      resolvedParams: { stockid: resolved.id, stockname: resolved.name },
      candidates: [{ id: resolved.id, name: resolved.name, type: resolved.type }],
    };
  }

  const matches = stockTextMatches(directory, text);
  if (matches.length === 1) {
    const stock = matches[0];
    return {
      status: 'resolved',
      source: 'text',
      resolvedParams: { stockid: stock.id, stockname: stock.name },
      candidates: [{ id: stock.id, name: stock.name, type: stock.type }],
    };
  }
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      source: 'text',
      reason: 'multiple_stocks',
      resolvedParams: {},
      candidates: matches.map(({ id, name, type }) => ({ id, name, type })),
    };
  }
  return {
    status: 'unresolved',
    source: 'text',
    reason: directory.length === 0 ? 'stock_directory_unavailable' : 'stock_not_found',
    resolvedParams: {},
    candidates: [],
  };
}

function resolveStock(catalog, text = '', provided = {}) {
  validateCatalog(catalog);
  return resolveStockValidated(catalog, text, provided);
}

function suggestRoutes(catalog, text, limit = 5, providedParams = {}) {
  validateCatalog(catalog);
  if (typeof text !== 'string' || text.trim() === '') {
    throw new CliError('suggest 需要非空的 --text', 'missing_text');
  }
  const normalizedText = normalizeForMatch(text);
  const stockResolution = resolveStockValidated(catalog, text, providedParams);
  const suggestions = catalog.routes
    .map((route) => {
      const matches = [];
      let score = 0;
      const terms = [...new Set([route.name, route.id, ...route.intentTerms])];
      for (const term of terms) {
        const normalizedTerm = normalizeForMatch(term);
        if (!normalizedTerm || !normalizedText.includes(normalizedTerm)) continue;
        matches.push(term);
        score += 10 + Math.min(normalizedTerm.length, 20);
      }
      if (!route.captureAllowed) score -= 1000;
      if (route.sideEffectRisk !== 'none') score -= 1000;
      const requiredParams = paramNames(route.requiredParams);
      const allowedParams = new Set([...requiredParams, ...paramNames(route.optionalParams)]);
      const resolvedParams = {};
      for (const [name, value] of Object.entries(providedParams)) {
        if (allowedParams.has(name) && value !== undefined && String(value).trim() !== '') {
          resolvedParams[name] = String(value);
        }
      }
      if (route.page === 'stock' && stockResolution.status === 'resolved') {
        for (const [name, value] of Object.entries(stockResolution.resolvedParams)) {
          if (allowedParams.has(name)) resolvedParams[name] = value;
        }
      }
      const missingParams = requiredParams.filter(
        (name) => resolvedParams[name] === undefined,
      );
      return {
        route: route.id,
        name: route.name,
        score,
        matchedTerms: matches,
        routeCaptureAllowed: route.captureAllowed,
        sideEffectRisk: route.sideEffectRisk,
        requiredParams,
        missingParams,
        resolvedParams,
        stockResolution:
          route.page === 'stock'
            ? {
                status: stockResolution.status,
                reason: stockResolution.reason || null,
                candidates: stockResolution.candidates,
              }
            : null,
      };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.route.localeCompare(b.route))
    .slice(0, limit);
  const requiresRouteChoice = suggestions.length !== 1;
  const requiresInput = suggestions.some((suggestion) => suggestion.missingParams.length > 0);
  const unresolvedGates = [];
  if (requiresRouteChoice) unresolvedGates.push('route_choice');
  const unresolvedStockIsNeeded = suggestions.some(
    (suggestion) =>
      suggestion.stockResolution &&
      suggestion.stockResolution.status !== 'resolved' &&
      suggestion.missingParams.some((name) => name === 'stockid' || name === 'stockname'),
  );
  if (unresolvedStockIsNeeded) unresolvedGates.push(stockResolution.reason);
  else if (requiresInput) unresolvedGates.push('required_input');
  const planReady = !requiresRouteChoice && !requiresInput;
  return {
    text,
    requestedScope: 'planning_only',
    captureAuthorization: 'not_requested',
    suggestions,
    requiresRouteChoice,
    requiresInput,
    planReady,
    unresolvedGates,
    requiresHumanChoice: unresolvedGates.length > 0,
  };
}

function routeById(catalog, routeId) {
  const route = catalog.routes.find((candidate) => candidate.id === routeId);
  if (!route) throw new CliError(`catalog 沒有 route：${routeId}`, 'route_not_found');
  return route;
}

function paramNames(specs) {
  return (specs || []).map((spec) => (typeof spec === 'string' ? spec : spec.name));
}

function inputProvidedParams(input = {}) {
  const params = Object.create(null);
  const put = (key, value) => {
    const stringValue = String(value);
    if (params[key] !== undefined && params[key] !== stringValue) {
      throw new CliError(
        `同一參數被提供不同值：${key}`,
        key === 'stockid' || key === 'stockname' ? 'stock_conflict' : 'conflicting_param',
      );
    }
    params[key] = stringValue;
  };
  if (input.stockId !== undefined) put('stockid', input.stockId);
  if (input.stockName !== undefined) put('stockname', input.stockName);
  for (const item of input.params || []) {
    const splitAt = item.indexOf('=');
    if (splitAt <= 0) throw new CliError(`--param 必須是 key=value：${item}`, 'invalid_param');
    const key = item.slice(0, splitAt);
    const value = item.slice(splitAt + 1);
    if (!key || !value) throw new CliError(`--param 必須是 key=value：${item}`, 'invalid_param');
    put(key, value);
  }
  return params;
}

function normalizeParams(route, input = {}, resolvedParams = {}) {
  const params = inputProvidedParams(input);
  for (const [key, value] of Object.entries(resolvedParams)) params[key] = String(value);

  const requiredNames = paramNames(route.requiredParams);
  const optionalNames = paramNames(route.optionalParams);
  const allowed = new Set([...requiredNames, ...optionalNames]);
  for (const [key, value] of Object.entries(params)) {
    if (Object.hasOwn(route.fixedParams || {}, key)) {
      throw new CliError(
        `route ${route.id} 的固定參數不得由使用者覆寫：${key}`,
        'fixed_param_override',
      );
    }
    if (!allowed.has(key)) throw new CliError(`route ${route.id} 不允許參數：${key}`, 'param_not_allowed');
    if (SENSITIVE_NAME.test(key)) throw new CliError(`不得使用敏感參數：${key}`, 'sensitive_param');
    if (String(value).trim() === '') throw new CliError(`參數 ${key} 不得為空`, 'invalid_param');
  }
  const missing = requiredNames.filter((name) => params[name] === undefined);
  if (missing.length > 0) {
    throw new CliError(`route ${route.id} 缺少必要參數：${missing.join(', ')}`, 'missing_param', { missing });
  }
  return params;
}

function buildPlan(catalog, input, now = new Date()) {
  validateCatalog(catalog);
  const mode = input.mode || 'live';
  if (!['live', 'test'].includes(mode)) throw new CliError('--mode 必須是 live 或 test', 'invalid_mode');
  if (mode === 'live') {
    if (!input.scriptDate) throw new CliError('live 模式必須提供 --script-date', 'script_date_required');
    assertCalendarDate(input.scriptDate);
    const today = localDate(now);
    if (input.scriptDate !== today) {
      throw new CliError(
        `live 模式的 script-date 必須是本機今天 ${today}；歷史講稿請使用 test 模式`,
        'stale_script_date',
      );
    }
  } else if (input.scriptDate) {
    assertCalendarDate(input.scriptDate);
  }

  const route = routeById(catalog, input.route);
  if (!route.captureAllowed) throw new CliError(`route ${route.id} 禁止自動截圖`, 'capture_not_allowed');
  if (route.sideEffectRisk !== 'none') {
    throw new CliError(
      `route ${route.id} 的 sideEffectRisk=${route.sideEffectRisk}，禁止自動截圖`,
      'side_effect_risk',
    );
  }
  const requiresRootNavigation = route.requiresRootNavigation === true;
  const providedParams = inputProvidedParams(input);
  let stockResolution = null;
  if (route.page === 'stock') {
    stockResolution = resolveStockValidated(catalog, input.text || '', providedParams);
  }
  const allowedRouteParams = new Set([
    ...paramNames(route.requiredParams),
    ...paramNames(route.optionalParams),
  ]);
  const resolvedRouteParams = Object.fromEntries(
    Object.entries(stockResolution?.status === 'resolved' ? stockResolution.resolvedParams : {})
      .filter(([name]) => allowedRouteParams.has(name)),
  );
  const params = normalizeParams(
    route,
    input,
    resolvedRouteParams,
  );
  const url = new URL(
    `${ALLOWED_TARGET.customScheme}://${ALLOWED_TARGET.landingHost}${ALLOWED_TARGET.landingPath}`,
  );
  url.searchParams.set('page', route.page);
  url.searchParams.set('subpage', String(route.subpage));
  for (const key of [...paramNames(route.requiredParams), ...paramNames(route.optionalParams)]) {
    if (params[key] !== undefined) url.searchParams.set(key, params[key]);
  }
  for (const [key, value] of Object.entries(catalog.product.defaultQuery || {})) {
    if (requiresRootNavigation && key === 'noReloadApp') continue;
    url.searchParams.set(key, value);
  }
  for (const [key, value] of Object.entries(route.fixedParams || {})) {
    url.searchParams.set(key, String(value));
  }
  if (
    url.protocol !== `${ALLOWED_TARGET.customScheme}:` ||
    url.hostname !== ALLOWED_TARGET.landingHost ||
    url.pathname !== ALLOWED_TARGET.landingPath
  ) {
    throw new CliError('產生的 URL 不在允許的 Deep Link 範圍', 'url_not_allowed');
  }

  const expectedTexts = route.expectedTexts.length
    ? [...route.expectedTexts]
    : route.page === 'stock'
      ? [route.name]
      : [...catalog.product.defaultExpectedTexts];
  const contentTexts = [...(route.contentTexts || [])];
  if (route.page === 'stock') {
    const knownStockName = stockResolution?.resolvedParams.stockname || params.stockname;
    if (params.stockid !== undefined) {
      expectedTexts.push(params.stockid);
      if (knownStockName !== undefined) contentTexts.push(knownStockName);
    } else if (knownStockName !== undefined) {
      // 理論上的 name-only route 沒有可驗證代號時，名稱仍是唯一可用的股票 identity gate。
      expectedTexts.push(knownStockName);
    }
  }
  const uniqueExpectedTexts = [...new Set(expectedTexts)];
  const uniqueContentTexts = [...new Set(contentTexts)];
  return {
    dryRun: true,
    requestedScope: 'planning_only',
    nextAction: 'stop_after_plan',
    mode,
    scriptDate: input.scriptDate || null,
    route: {
      id: route.id,
      name: route.name,
      page: route.page,
      subpage: String(route.subpage),
      sideEffectRisk: route.sideEffectRisk,
      requiresRootNavigation,
    },
    url: url.toString(),
    parameters: Object.fromEntries(url.searchParams.entries()),
    expectedTexts: uniqueExpectedTexts,
    contentTexts: uniqueContentTexts,
    planReady: true,
    unresolvedGates: [],
    captureGate: {
      authorization: 'required',
      persona: 'vip',
      sessionConfirmation: 'required',
      nextAction: 'await_capture_authorization',
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

function exactSimulator(devicesJson, udid) {
  const matches = [];
  for (const [runtime, devices] of Object.entries(devicesJson.devices || {})) {
    for (const device of devices || []) {
      if (device.udid === udid) matches.push({ ...device, runtime });
    }
  }
  if (matches.length !== 1) {
    throw new CliError(`找不到 exact Simulator UDID：${udid}`, 'simulator_not_found');
  }
  return matches[0];
}

function plistValue(infoPath, key, exec = defaultExec) {
  return exec('plutil', ['-extract', key, 'raw', '-o', '-', infoPath]);
}

function runPreflight(catalog, input, deps = {}) {
  validateCatalog(catalog);
  const udid = input.udid;
  if (!UDID_RE.test(udid || '')) throw new CliError('--udid 必須是完整 Simulator UDID', 'invalid_udid');
  const exec = deps.exec || defaultExec;
  let devicesJson;
  try {
    devicesJson = JSON.parse(exec('xcrun', ['simctl', 'list', 'devices', '--json']));
  } catch (error) {
    throw new CliError(`無法讀取 Simulator 清單：${error.message}`, 'simctl_unavailable');
  }
  const device = exactSimulator(devicesJson, udid);
  if (device.isAvailable === false) throw new CliError(`Simulator ${udid} 不可用`, 'simulator_unavailable');
  if (device.state !== 'Booted') throw new CliError(`Simulator ${udid} 尚未 Booted`, 'simulator_not_booted');

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
    throw new CliError(
      `Simulator ${udid} 尚未安裝 ${catalog.product.bundleId}`,
      'app_not_installed',
    );
  }
  const infoPath = path.join(appPath, 'Info.plist');
  let version;
  let build;
  try {
    version = plistValue(infoPath, 'CFBundleShortVersionString', exec);
    build = plistValue(infoPath, 'CFBundleVersion', exec);
  } catch (error) {
    throw new CliError(`無法讀取 App 版本：${error.message}`, 'app_metadata_unavailable');
  }

  let ocrLanguages = [];
  try {
    ocrLanguages = exec('tesseract', ['--list-langs'])
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !line.startsWith('List of available languages'));
  } catch (error) {
    throw new CliError('找不到 tesseract OCR', 'ocr_unavailable');
  }
  if (!ocrLanguages.includes('chi_tra')) {
    throw new CliError('tesseract 缺少 chi_tra 語言資料', 'ocr_language_missing');
  }
  return {
    ok: true,
    udid,
    device: { name: device.name, state: device.state, runtime: device.runtime },
    bundle: { id: catalog.product.bundleId, version, build },
    ocr: { engine: 'tesseract', language: 'chi_tra' },
  };
}

function getSourceVersion(catalog) {
  const source = catalog.source || {};
  const declared =
    catalog.sourceVersion ||
    source.version ||
    source.commit ||
    source.revision ||
    catalog.updatedAt;
  if (declared) return String(declared);
  const sourceVersions = (catalog.sources || [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const version =
        item.sourceCommit || item.version || item.revision || item.modifiedAt || item.reviewedAt;
      return version ? `${item.kind || 'source'}@${version}` : null;
    })
    .filter(Boolean);
  if (sourceVersions.length > 0) return sourceVersions.join('|');
  if (catalog.catalogVersion) return String(catalog.catalogVersion);
  const digest = crypto.createHash('sha256').update(JSON.stringify(catalog)).digest('hex');
  return `sha256:${digest}`;
}

const DENSE_OCR_MAX_HORIZONTAL_GAP_HEIGHTS = 0.75;
const DENSE_OCR_MIN_VERTICAL_OVERLAP = 0.5;

function denseWordGeometry(word) {
  const text = String(word?.t ?? '');
  const values = ['x', 'y', 'w', 'h'].map((key) => Number(word?.[key]));
  if (text.trim() === '' || values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, w, h] = values;
  if (w <= 0 || h <= 0) return null;
  return { text, x, y, w, h };
}

function denseWordsShareRow(first, second) {
  const overlap = Math.max(
    0,
    Math.min(first.y + first.h, second.y + second.h) - Math.max(first.y, second.y),
  );
  return overlap / Math.min(first.h, second.h) >= DENSE_OCR_MIN_VERTICAL_OVERLAP;
}

function denseWordsAreContiguous(first, second) {
  if (!denseWordsShareRow(first, second)) return false;
  const horizontalGap = second.x - (first.x + first.w);
  const maxHorizontalGap = Math.max(first.h, second.h)
    * DENSE_OCR_MAX_HORIZONTAL_GAP_HEIGHTS;
  return horizontalGap <= maxHorizontalGap;
}

function denseClusterNode(words) {
  const x = Math.min(...words.map((word) => word.x));
  const y = Math.min(...words.map((word) => word.y));
  const right = Math.max(...words.map((word) => word.x + word.w));
  const bottom = Math.max(...words.map((word) => word.y + word.h));
  return {
    text: words.map((word) => word.text).join(''),
    x,
    y,
    w: right - x,
    h: bottom - y,
  };
}

function denseWordClusters(line) {
  // Hand-authored tests may opt into text-only input explicitly. Runtime OCR always supplies
  // word boxes; missing or malformed production geometry must fail closed.
  if (line?.synthetic === true && line.words === undefined) {
    if (!normalizeForMatch(line.text)) return [];
    const node = { text: String(line.text) };
    const values = ['x', 'y', 'w', 'h'].map((key) => Number(line?.[key]));
    if (
      values.every((value) => Number.isFinite(value)) &&
      values[2] > 0 &&
      values[3] > 0
    ) {
      [node.x, node.y, node.w, node.h] = values;
    }
    return [node];
  }
  if (!Array.isArray(line?.words) || line.words.length === 0) return [];
  const words = line.words.map(denseWordGeometry);
  if (words.some((word) => word === null)) return [];
  words.sort((first, second) => first.x - second.x || first.y - second.y);

  const clusters = [];
  let cluster = [words[0]];
  for (const word of words.slice(1)) {
    const previous = cluster[cluster.length - 1];
    const clusterStart = cluster[0];
    if (
      denseWordsAreContiguous(previous, word) &&
      denseWordsShareRow(clusterStart, word)
    ) {
      cluster.push(word);
    } else {
      clusters.push(cluster);
      cluster = [word];
    }
  }
  clusters.push(cluster);
  return clusters.map(denseClusterNode);
}

function denseTextCandidates(line) {
  return denseWordClusters(line).map((cluster) => cluster.text);
}

function matchedExpectedTexts(lines, expectedTexts) {
  // Default and PSM6 may group horizontally separated columns into one TSV line. Only exact
  // normalized substrings inside a contiguous same-row word cluster are eligible. Wrapped text
  // belongs to the geometry-aware PSM11 fallback below.
  const candidates = lines
    .flatMap(denseTextCandidates)
    .map(normalizeForMatch)
    .filter(Boolean);
  const matched = expectedTexts.filter((text) => {
    const expected = normalizeForMatch(text);
    return expected && candidates.some((candidate) => candidate.includes(expected));
  });
  return { matched, missing: expectedTexts.filter((text) => !matched.includes(text)) };
}

const SPARSE_OCR_MAX_CHAIN_LINES = 3;
const SPARSE_OCR_MAX_VERTICAL_GAP_HEIGHTS = 1.5;
const SPARSE_OCR_MAX_VERTICAL_OVERLAP_HEIGHTS = 0.2;
const SPARSE_OCR_MIN_HORIZONTAL_OVERLAP = 0.5;
const SPARSE_OCR_SPATIAL_STRATEGY = 'word_cluster_chain_start_alignment_v4';

function sparseLineGeometry(line) {
  const values = ['x', 'y', 'w', 'h'].map((key) => Number(line?.[key]));
  if (values.some((value) => !Number.isFinite(value))) return null;
  const [x, y, w, h] = values;
  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function horizontalOverlapRatio(first, second) {
  const overlap = Math.max(
    0,
    Math.min(first.x + first.w, second.x + second.w) - Math.max(first.x, second.x),
  );
  return overlap / Math.min(first.w, second.w);
}

function sparseLinesShareColumn(first, second) {
  const firstBox = sparseLineGeometry(first);
  const secondBox = sparseLineGeometry(second);
  if (!firstBox || !secondBox) return false;
  return horizontalOverlapRatio(firstBox, secondBox) >= SPARSE_OCR_MIN_HORIZONTAL_OVERLAP;
}

function isNextSparseLine(first, second) {
  const firstBox = sparseLineGeometry(first);
  const secondBox = sparseLineGeometry(second);
  if (!firstBox || !secondBox) return false;
  const firstCenterY = firstBox.y + firstBox.h / 2;
  const secondCenterY = secondBox.y + secondBox.h / 2;
  if (secondCenterY <= firstCenterY) return false;
  if (!sparseLinesShareColumn(first, second)) return false;
  const verticalGap = secondBox.y - (firstBox.y + firstBox.h);
  const minAllowedGap = -Math.min(firstBox.h, secondBox.h)
    * SPARSE_OCR_MAX_VERTICAL_OVERLAP_HEIGHTS;
  const maxAllowedGap = Math.max(firstBox.h, secondBox.h)
    * SPARSE_OCR_MAX_VERTICAL_GAP_HEIGHTS;
  return verticalGap >= minAllowedGap && verticalGap <= maxAllowedGap;
}

function sparseTextCandidates(lines) {
  // PSM11 may still group separate columns into one TSV line. Normalize every line into the same
  // bounded word clusters used by dense OCR, then treat those cluster boxes as the only atomic
  // candidates for short downward chains. Never seed a candidate from raw line.text.
  const ordered = lines
    .flatMap((line, lineIndex) =>
      denseWordClusters(line).map((cluster, clusterIndex) => ({
        ...cluster,
        nodeId: `${lineIndex}:${clusterIndex}`,
      })),
    )
    .filter((line) => normalizeForMatch(line.text) && sparseLineGeometry(line))
    .sort((first, second) => {
      const firstBox = sparseLineGeometry(first);
      const secondBox = sparseLineGeometry(second);
      return firstBox.y - secondBox.y || firstBox.x - secondBox.x ||
        first.nodeId.localeCompare(second.nodeId);
    });
  const candidates = new Set(ordered.map((line) => line.text));

  for (const start of ordered) {
    if (!sparseLineGeometry(start)) continue;
    let current = start;
    let combined = start.text;
    for (let depth = 1; depth < SPARSE_OCR_MAX_CHAIN_LINES; depth += 1) {
      const next = ordered
        .filter((candidate) =>
          candidate.nodeId !== current.nodeId &&
          isNextSparseLine(current, candidate) &&
          sparseLinesShareColumn(start, candidate),
        )
        .sort((first, second) => {
          const firstBox = sparseLineGeometry(first);
          const secondBox = sparseLineGeometry(second);
          const currentBox = sparseLineGeometry(current);
          const firstGap = firstBox.y - (currentBox.y + currentBox.h);
          const secondGap = secondBox.y - (currentBox.y + currentBox.h);
          return firstGap - secondGap || firstBox.x - secondBox.x ||
            first.nodeId.localeCompare(second.nodeId);
        })[0];
      if (!next) break;
      combined += next.text;
      candidates.add(combined);
      current = next;
    }
  }
  return [...candidates];
}

function matchedSparseExpectedTexts(lines, expectedTexts) {
  const candidates = sparseTextCandidates(lines).map(normalizeForMatch);
  const matched = expectedTexts.filter((text) => {
    const expected = normalizeForMatch(text);
    return expected && candidates.some((candidate) => candidate.includes(expected));
  });
  return { matched, missing: expectedTexts.filter((text) => !matched.includes(text)) };
}

function mergeExpectedTextMatches(expectedTexts, ...matches) {
  const observed = new Set(matches.flatMap((match) => match.matched));
  const matched = expectedTexts.filter((text) => observed.has(text));
  return { matched, missing: expectedTexts.filter((text) => !observed.has(text)) };
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertFreshDestination(filePath, label) {
  if (!filePath) throw new CliError(`${label} 為必要參數`, 'missing_output');
  if (fs.existsSync(filePath)) throw new CliError(`${label} 已存在，拒絕覆寫：${filePath}`, 'output_exists');
}

async function captureRoute(catalog, input, deps = {}) {
  if (input.confirmVipSession !== true) {
    throw new CliError(
      'capture 前必須先確認指定 Simulator 目前為 VIP session，並顯式加上 --confirm-vip-session',
      'vip_session_confirmation_required',
    );
  }
  const output = path.resolve(input.output || '');
  const manifestPath = path.resolve(input.manifest || '');
  if (!String(input.output || '').toLowerCase().endsWith('.png')) {
    throw new CliError('--output 必須是 .png', 'invalid_output');
  }
  if (!String(input.manifest || '').toLowerCase().endsWith('.json')) {
    throw new CliError('--manifest 必須是 .json', 'invalid_manifest');
  }
  if (output === manifestPath) throw new CliError('output 與 manifest 不得是同一檔案', 'invalid_output');
  assertFreshDestination(output, 'output');
  assertFreshDestination(manifestPath, 'manifest');

  const plan = buildPlan(catalog, input, deps.now ? deps.now() : new Date());
  const exec = deps.exec || defaultExec;
  const preflight = runPreflight(catalog, input, { exec });
  const timeoutMs = input.timeoutMs === undefined ? 30000 : Number(input.timeoutMs);
  const pollMs = input.pollMs === undefined ? 1000 : Number(input.pollMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new CliError('--timeout-ms 必須介於 1000 與 120000', 'invalid_timeout');
  }
  if (!Number.isFinite(pollMs) || pollMs < 250 || pollMs > 5000) {
    throw new CliError('--poll-ms 必須介於 250 與 5000', 'invalid_poll');
  }

  const outputParents = new Set([path.dirname(output), path.dirname(manifestPath)]);
  if (outputParents.size !== 1) {
    throw new CliError('output 與 manifest 必須位於同一個 caller output directory', 'output_directory_mismatch');
  }
  const callerOutputDirectory = [...outputParents][0];
  fs.mkdirSync(callerOutputDirectory, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(callerOutputDirectory, '.chipk-simulator-capture-'));
  const tempScreenshot = path.join(tempDir, 'screen.png');
  const ocr = deps.ocrLines || ocrLines;
  const wait = deps.sleep || sleep;
  const clock = deps.clock || Date.now;
  const started = clock();
  const ocrModesTried = new Set();
  let ocrCallCount = 0;
  let pollAttemptCount = 0;
  let result;
  try {
    exec('xcrun', ['simctl', 'openurl', input.udid, plan.url]);
    while (clock() - started <= timeoutMs) {
      pollAttemptCount += 1;
      exec('xcrun', ['simctl', 'io', input.udid, 'screenshot', tempScreenshot]);
      ocrModesTried.add('default');
      ocrCallCount += 1;
      let resolvedBy = 'default';
      let lines = ocr(tempScreenshot, 'chi_tra');
      let sparseLines = null;
      const runSparseOcr = () => {
        if (sparseLines !== null) return sparseLines;
        ocrModesTried.add('psm11');
        ocrCallCount += 1;
        sparseLines = ocr(tempScreenshot, 'chi_tra', { psm: 11 });
        return sparseLines;
      };
      let match = matchedExpectedTexts(lines, plan.expectedTexts);
      if (match.missing.length > 0) {
        ocrModesTried.add('psm6');
        ocrCallCount += 1;
        resolvedBy = 'psm6';
        lines = [...lines, ...ocr(tempScreenshot, 'chi_tra', { psm: 6 })];
        match = matchedExpectedTexts(lines, plan.expectedTexts);
      }
      if (match.missing.length > 0) {
        resolvedBy = 'psm11_spatial';
        const sparseMatch = matchedSparseExpectedTexts(runSparseOcr(), match.missing);
        match = mergeExpectedTextMatches(plan.expectedTexts, match, sparseMatch);
      }
      if (match.missing.length === 0) {
        let contentMatch = matchedExpectedTexts(lines, plan.contentTexts);
        if (contentMatch.missing.length > 0) {
          const sparseContentMatch = matchedSparseExpectedTexts(
            runSparseOcr(),
            contentMatch.missing,
          );
          contentMatch = mergeExpectedTextMatches(
            plan.contentTexts,
            contentMatch,
            sparseContentMatch,
          );
        }
        result = { match, contentMatch, elapsedMs: clock() - started, resolvedBy };
        break;
      }
      await wait(pollMs);
    }
    if (!result) {
      throw new CliError(
        `等待畫面逾時；OCR 未同時找到：${plan.expectedTexts.join(', ')}`,
        'expected_text_timeout',
      );
    }

    const digest = sha256(tempScreenshot);
    const capturedAt = new Date().toISOString();
    const manifest = {
      schemaVersion: 1,
      capturedAt,
      route: plan.route,
      resolvedUrl: plan.url,
      parameters: plan.parameters,
      mode: plan.mode,
      scriptDate: plan.scriptDate,
      udid: input.udid,
      bundle: preflight.bundle,
      device: preflight.device,
      ocr: preflight.ocr,
      screenshot: {
        file: path.basename(output),
        sha256: digest,
      },
      verification: {
        expectedTexts: plan.expectedTexts,
        matchedTexts: result.match.matched,
        contentTexts: {
          expected: plan.contentTexts,
          observed: result.contentMatch.matched,
          missing: result.contentMatch.missing,
        },
        ocrReadiness: {
          modesTried: [...ocrModesTried],
          sparseFallbackAttempted: ocrModesTried.has('psm11'),
          spatialStrategy: ocrModesTried.has('psm11') ? SPARSE_OCR_SPATIAL_STRATEGY : null,
          resolvedBy: result.resolvedBy,
          pollAttemptCount,
          ocrCallCount,
        },
        elapsedMs: result.elapsedMs,
      },
      catalogVersion: catalog.catalogVersion || null,
      sourceVersion: getSourceVersion(catalog),
    };

    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.copyFileSync(tempScreenshot, output, fs.constants.COPYFILE_EXCL);
    try {
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
      });
    } catch (error) {
      try {
        fs.unlinkSync(output);
      } catch (_) {}
      throw error;
    }
    return { ok: true, output, manifest: manifestPath, ...manifest };
  } finally {
    try {
      fs.unlinkSync(tempScreenshot);
    } catch (_) {}
    try {
      fs.rmdirSync(tempDir);
    } catch (_) {}
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const values = Object.create(null);
  const booleans = new Set(['json', 'confirm-vip-session']);
  const repeatable = new Set(['param']);
  const allowedFlags = {
    'catalog-check': new Set(['json']),
    suggest: new Set(['text', 'stock-id', 'stock-name', 'param', 'json']),
    plan: new Set(['route', 'mode', 'script-date', 'stock-id', 'stock-name', 'param', 'json']),
    preflight: new Set(['udid', 'json']),
    capture: new Set([
      'route',
      'mode',
      'script-date',
      'stock-id',
      'stock-name',
      'param',
      'udid',
      'output',
      'manifest',
      'timeout-ms',
      'poll-ms',
      'confirm-vip-session',
      'json',
    ]),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new CliError(`無法識別的參數：${item}`, 'unknown_argument');
    const equalAt = item.indexOf('=');
    const key = item.slice(2, equalAt >= 0 ? equalAt : undefined);
    if (allowedFlags[command] && !allowedFlags[command].has(key)) {
      throw new CliError(`${command} 不允許 flag：--${key}`, 'unknown_flag');
    }
    if (booleans.has(key)) {
      if (equalAt >= 0) throw new CliError(`--${key} 不接受值`, 'invalid_boolean_flag');
      if (values[key] !== undefined) throw new CliError(`--${key} 不得重複`, 'duplicate_argument');
      values[key] = true;
      continue;
    }
    const value = equalAt >= 0 ? item.slice(equalAt + 1) : argv[++index];
    if (value === undefined || value.startsWith('--')) throw new CliError(`--${key} 缺少值`, 'missing_value');
    if (repeatable.has(key)) {
      if (!values[key]) values[key] = [];
      values[key].push(value);
    } else if (values[key] !== undefined) {
      throw new CliError(`--${key} 不得重複`, 'duplicate_argument');
    } else {
      values[key] = value;
    }
  }
  return { command, values };
}

function commonPlanInput(values) {
  return {
    route: values.route,
    mode: values.mode || 'live',
    scriptDate: values['script-date'],
    stockId: values['stock-id'],
    stockName: values['stock-name'],
    params: values.param || [],
  };
}

function providedParamsFromValues(values) {
  const params = Object.create(null);
  if (values['stock-id'] !== undefined) params.stockid = values['stock-id'];
  if (values['stock-name'] !== undefined) params.stockname = values['stock-name'];
  for (const item of values.param || []) {
    const splitAt = item.indexOf('=');
    if (splitAt > 0) params[item.slice(0, splitAt)] = item.slice(splitAt + 1);
  }
  return params;
}

function print(value, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  if (value.url) process.stdout.write(`${value.url}\n`);
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return [
    '用法：',
    '  node scripts/simulator-capture.js catalog-check [--json]',
    '  node scripts/simulator-capture.js suggest --text "講稿" [--stock-id 2330] [--stock-name 台積電] [--json]',
    '  node scripts/simulator-capture.js plan --route <id> --mode live|test [--script-date YYYY-MM-DD] [--stock-id 2330] [--stock-name 台積電] [--json]',
    '  node scripts/simulator-capture.js preflight --udid <exact-udid> [--json]',
    '  node scripts/simulator-capture.js capture --route <id> --mode live|test --udid <exact-udid> --confirm-vip-session --output <file.png> --manifest <file.json> [plan options] [--json]',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const catalog = readCatalog();
  if (command === 'catalog-check') {
    print({ ...validateCatalog(catalog), catalog: CATALOG_PATH }, values.json);
    return;
  }
  if (command === 'suggest') {
    print(suggestRoutes(catalog, values.text, 5, providedParamsFromValues(values)), values.json);
    return;
  }
  if (command === 'plan') {
    print(buildPlan(catalog, commonPlanInput(values)), values.json);
    return;
  }
  if (command === 'preflight') {
    print(runPreflight(catalog, { udid: values.udid }), values.json);
    return;
  }
  if (command === 'capture') {
    print(
      await captureRoute(catalog, {
        ...commonPlanInput(values),
        udid: values.udid,
        output: values.output,
        manifest: values.manifest,
        timeoutMs: values['timeout-ms'],
        pollMs: values['poll-ms'],
        confirmVipSession: values['confirm-vip-session'] === true,
      }),
      values.json,
    );
    return;
  }
  throw new CliError(`未知 command：${command}\n${usage()}`, 'unknown_command');
}

if (require.main === module) {
  main().catch((error) => {
    const json = process.argv.includes('--json');
    const payload = { ok: false, error: error.code || 'unexpected_error', message: error.message };
    if (error.details) payload.details = error.details;
    const message = json ? JSON.stringify(payload, null, 2) : `錯誤：${error.message}`;
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  ALLOWED_TARGET,
  CATALOG_PATH,
  CliError,
  buildPlan,
  captureRoute,
  exactSimulator,
  getSourceVersion,
  localDate,
  matchedExpectedTexts,
  matchedSparseExpectedTexts,
  normalizeForMatch,
  parseArgs,
  readCatalog,
  resolveStock,
  runPreflight,
  suggestRoutes,
  validateCatalog,
};
