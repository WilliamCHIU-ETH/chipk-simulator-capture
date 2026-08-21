'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sourceFixture = require('../fixtures/synthetic/source-bundle.json');
const {
  compileCatalogBytes,
  refreshCatalog,
} = require('../src/catalog-compiler');
const {
  sourceContentIssues,
  structuredValueIssues,
} = require('../src/sensitive-taxonomy');
const {
  inspectJsonContent,
  scanTree,
  trackedSourceIssues,
} = require('./sanitized-tree-check');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('sanitized source bundle compiles deterministically', () => {
  const first = compileCatalogBytes(sourceFixture);
  const reordered = clone(sourceFixture);
  reordered.routes.reverse();
  assert.equal(compileCatalogBytes(reordered).bytes, first.bytes);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('catalog compiler rejects private endpoints, user paths, and sensitive parameters', () => {
  const cases = [];
  const privateEndpoint = clone(sourceFixture);
  privateEndpoint.baseUrl = ['http:/', '/192.', '168.1.20/catalog'].join('');
  cases.push(privateEndpoint);
  const userPath = clone(sourceFixture);
  userPath.routes[0].fixedParams[0].value = ['/', 'Users/example/private.json'].join('');
  cases.push(userPath);
  const sensitiveParameter = clone(sourceFixture);
  sensitiveParameter.routes[0].fixedParams[0].name = 'accessToken';
  cases.push(sensitiveParameter);
  for (const value of cases) {
    assert.throws(() => compileCatalogBytes(value), { code: 'PRIVATE_SOURCE_DATA' });
  }
});

test('catalog refresh writes only one new deterministic catalog', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-refresh-test-'));
  try {
    const input = path.join(root, 'source.json');
    const output = path.join(root, 'output');
    fs.mkdirSync(output);
    fs.writeFileSync(input, `${JSON.stringify(sourceFixture)}\n`);
    const result = refreshCatalog({ inputPath: input, outputDirectory: output });
    assert.equal(result.targetFile, 'catalog.json');
    assert.match(result.digest, /^[a-f0-9]{64}$/);
    assert.throws(() => refreshCatalog({ inputPath: input, outputDirectory: output }), {
      code: 'OUTPUT_EXISTS',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('source-only taxonomy rejects concrete private values but permits runtime source', () => {
  assert.ok(sourceContentIssues(['endpoint=http:/', '/192.', '168.1.20/private'].join('')).length > 0);
  assert.ok(sourceContentIssues(['owner=user', '@example.com'].join('')).length > 0);
  assert.ok(sourceContentIssues(['path=/', 'Users/example/private.json'].join('')).length > 0);
  assert.deepEqual(sourceContentIssues("require('node:child_process')"), []);
  assert.deepEqual(sourceContentIssues('https://www.cmoney.tw/app/landing_page/chipk'), []);
  assert.deepEqual(sourceContentIssues('/Applications/Xcode.app/Contents/Developer'), []);
  assert.ok(sourceContentIssues([
    'const keychain', 'Service = "real-local-service";',
  ].join('')).includes('identity or credential locator'));
  assert.deepEqual(sourceContentIssues([
    'const keychain', 'Service = "replace-locally";',
  ].join('')), []);
});

test('JSON inspection rejects secret values and private endpoints after parsing', () => {
  assert.ok(inspectJsonContent('{"token":"actual-value"}', 'fixture').length > 0);
  assert.ok(inspectJsonContent(['{"endpoint":"http:/', '/127.', '0.0.1/private"}'].join(''), 'fixture').length > 0);
  assert.deepEqual(inspectJsonContent('{"role":"vip","host":"www.cmoney.tw"}', 'fixture'), []);
  assert.ok(structuredValueIssues({ queryName: 'sessionToken' }).length > 0);
});

test('tracked path policy blocks generated/runtime artifacts even when force-added', () => {
  const issues = trackedSourceIssues([
    '.runtime/screenshots/example.png',
    'outputs/report.pdf',
    'captures/raw.webm',
    'capture-manifest.json',
    ['.env', '.local'].join(''),
  ]);
  assert.equal(issues.length >= 5, true);
  assert.deepEqual(trackedSourceIssues(['src/runtime-adapter.js', 'config/simulator-capture.catalog.json']), []);
});

test('current worktree passes the source-only tree inspection', () => {
  assert.deepEqual(scanTree(), []);
});
