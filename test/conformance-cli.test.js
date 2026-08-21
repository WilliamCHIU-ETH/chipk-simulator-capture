'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const packageJson = require('../package.json');
const { validateResult } = require('../src/contract');

const CLI = path.join(__dirname, 'conformance-cli.js');

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-conformance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args) {
  return spawnSync(CLI, args, {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function writeRequest(root, outputDirectory, overrides = {}) {
  const requestPath = path.join(root, `request-${overrides.contractVersion || 1}.json`);
  fs.writeFileSync(requestPath, `${JSON.stringify({
    contractVersion: 1,
    requestId: 'provider-conformance-001',
    operation: 'screenshot',
    mode: 'test',
    target: {
      routeId: 'chipk.stock.health-check',
      stockId: '2330',
      stockName: '台積電',
    },
    outputDirectory,
    ...overrides,
  })}\n`, { flag: 'wx' });
  return requestPath;
}

test('conformance driver reports production package capabilities', () => {
  const completed = run(['capabilities', '--json']);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stderr, '');
  const capabilities = JSON.parse(completed.stdout);
  assert.equal(capabilities.providerId, 'chipk-simulator-capture');
  assert.equal(capabilities.schemaVersion, 1);
  assert.equal(capabilities.toolVersion, packageJson.version);
  assert.deepEqual(capabilities.operations, ['screenshot', 'record']);
});

test('conformance driver exercises production CLI and contract with synthetic screenshot output', (t) => {
  const root = tempDirectory(t);
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory);
  const requestPath = writeRequest(root, outputDirectory);

  const completed = run(['acquire', '--request', requestPath, '--json']);
  assert.equal(completed.status, 0, completed.stderr);
  assert.equal(completed.stderr, '');

  const result = validateResult(JSON.parse(completed.stdout));
  assert.equal(result.status, 'completed');
  assert.equal(result.provider.toolVersion, packageJson.version);
  assert.deepEqual(result.artifacts.map(({ role }) => role), ['screenshot', 'capture-manifest']);

  for (const artifact of result.artifacts) {
    const artifactPath = path.join(outputDirectory, artifact.relativePath);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    assert.equal(digest, artifact.sha256);
  }
  assert.deepEqual(result.artifacts[0].media, { width: 1, height: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(outputDirectory, 'capture-manifest.json'))), {
    schemaVersion: 1,
    fixture: 'synthetic-conformance',
  });
  assert.deepEqual(fs.readdirSync(outputDirectory).sort(), ['capture-manifest.json', 'screenshot.png']);
});

test('conformance driver rejects an incompatible contract without publishing artifacts', (t) => {
  const root = tempDirectory(t);
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory);
  const requestPath = writeRequest(root, outputDirectory, { contractVersion: 2 });

  const completed = run(['acquire', '--request', requestPath, '--json']);
  assert.equal(completed.status, 2);
  assert.equal(completed.stdout, '');
  assert.equal(JSON.parse(completed.stderr).error.code, 'UNSUPPORTED_CONTRACT');
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('conformance driver never delegates recording to the Simulator runtime', (t) => {
  const root = tempDirectory(t);
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory);
  const requestPath = writeRequest(root, outputDirectory, {
    requestId: 'provider-conformance-record-001',
    operation: 'record',
    target: {
      routeId: 'chipk.stock.kline',
      stockId: '2324',
      stockName: '仁寶',
      recipeId: 'renbao.kline-tab-switch-benchmark',
    },
  });

  const completed = run(['acquire', '--request', requestPath, '--json']);
  assert.equal(completed.status, 3, completed.stderr);
  assert.equal(completed.stderr, '');
  const result = validateResult(JSON.parse(completed.stdout));
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'CONFORMANCE_SCREENSHOT_ONLY');
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});
