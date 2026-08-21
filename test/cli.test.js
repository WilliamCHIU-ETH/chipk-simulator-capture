'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main, readRequest } = require('../src/cli');

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    values: () => ({ stdout, stderr }),
  };
}

function requestFile(t, value) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'request.json');
  fs.writeFileSync(target, `${JSON.stringify(value)}\n`, { flag: 'wx' });
  return target;
}

const provider = {
  capabilities: () => ({
    schemaVersion: 1,
    providerId: 'chipk-simulator-capture',
    productionReady: true,
    operations: ['screenshot', 'record'],
  }),
  acquire: async (request) => ({
    contractVersion: 1,
    requestId: request.requestId,
    provider: { id: 'chipk-simulator-capture', toolVersion: 'test' },
    status: 'human_action_required',
    artifacts: [],
    evidence: {},
    error: { code: 'RUNTIME_CONFIGURATION_REQUIRED', message: 'Configure provider.', retryable: true },
  }),
};

test('capabilities --json is the stable probe', async () => {
  const output = streams();
  assert.equal(await main(['capabilities', '--json'], output, { provider }), 0);
  const value = JSON.parse(output.values().stdout);
  assert.equal(value.productionReady, true);
  assert.deepEqual(value.operations, ['screenshot', 'record']);
  assert.equal(output.values().stderr, '');
});

test('acquire reads one absolute request file and emits full typed result on stdout', async (t) => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-cli-output-'));
  t.after(() => fs.rmSync(outputDirectory, { recursive: true, force: true }));
  const file = requestFile(t, {
    contractVersion: 1,
    requestId: 'cli-test-001',
    operation: 'screenshot',
    mode: 'test',
    target: { routeId: 'chipk.stock.health-check', stockId: '2330' },
    outputDirectory,
  });
  const output = streams();
  assert.equal(await main(['acquire', '--request', file, '--json'], output, { provider }), 3);
  const value = JSON.parse(output.values().stdout);
  assert.equal(value.status, 'human_action_required');
  assert.equal(value.error.code, 'RUNTIME_CONFIGURATION_REQUIRED');
  assert.equal(output.values().stderr, '');
});

test('CLI faults use stderr exit 2 and reject legacy public commands', async () => {
  for (const argv of [
    ['capture', '--json'],
    ['record', '--json'],
    ['plan', '--json'],
    ['capabilities'],
    ['acquire', '--request', 'relative.json', '--json'],
  ]) {
    const output = streams();
    assert.equal(await main(argv, output, { provider }), 2);
    assert.equal(output.values().stdout, '');
    assert.equal(JSON.parse(output.values().stderr).error.code, 'INVALID_CLI');
  }
});

test('request reader rejects symlinks, duplicate JSON keys, and relative paths', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-cli-read-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'request.json');
  fs.writeFileSync(target, '{"contractVersion":1,"contractVersion":1}\n');
  assert.throws(() => readRequest(target), { code: 'DUPLICATE_JSON_MEMBER' });
  const link = path.join(directory, 'link.json');
  fs.symlinkSync(target, link);
  assert.throws(() => readRequest(link), { code: 'INVALID_CLI' });
  assert.throws(() => readRequest('request.json'), { code: 'INVALID_CLI' });
});
