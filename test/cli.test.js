'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { main } = require('../src/cli');

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    values: () => ({ stdout, stderr }),
  };
}

test('capabilities expose the explicit fallback gate', async () => {
  const output = streams();
  assert.equal(await main(['capabilities', '--json'], output), 0);
  const value = JSON.parse(output.values().stdout);
  assert.equal(value.productionReady, false);
  assert.deepEqual(value.operations, []);
  assert.equal(value.planningAvailable, true);
});

test('capabilities validates a supplied catalog instead of ignoring it', async () => {
  const output = streams();
  const catalogFile = path.join(os.tmpdir(), `chipk-catalog-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(catalogFile, '{"schemaVersion":999}\n', { flag: 'wx' });
  try {
    assert.equal(await main(['capabilities', '--catalog', catalogFile, '--json'], output), 2);
    const value = JSON.parse(output.values().stderr);
    assert.equal(value.error.code, 'INVALID_CATALOG');
  } finally {
    fs.unlinkSync(catalogFile);
  }
});

test('plan reads only the supplied synthetic request', async () => {
  const output = streams();
  const request = path.join('fixtures', 'synthetic', 'request.json');
  assert.equal(await main(['plan', '--request', request, '--json'], output, path.resolve(__dirname, '..')), 0);
  const value = JSON.parse(output.values().stdout);
  assert.equal(value.route.id, 'chipk.fixture.stock-overview');
  assert.equal(value.verdicts.navigation, 'not_executed');
});

test('capture CLI rejects without creating its requested output directory', async () => {
  const output = streams();
  const root = path.resolve(__dirname, '..');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'synthetic', 'request.json'), 'utf8'));
  const outputDirectory = path.join(os.tmpdir(), `chipk-cli-${process.pid}-${Date.now()}`);
  fixture.outputDirectory = outputDirectory;
  const requestFile = path.join(os.tmpdir(), `chipk-request-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(requestFile, `${JSON.stringify(fixture)}\n`, { flag: 'wx' });
  try {
    assert.equal(await main([
      'capture',
      '--request',
      requestFile,
      '--authorize-run',
      '--confirm-dedicated-simulator',
      '--json',
    ], output, root), 3);
    const value = JSON.parse(output.values().stdout);
    assert.equal(value.status, 'rejected');
    assert.equal(value.error.code, 'PRODUCTION_NOT_READY');
    assert.equal(fs.existsSync(outputDirectory), false);
  } finally {
    fs.unlinkSync(requestFile);
  }
});
