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
const { probeVideo } = require('../src/prepared-state-renderer');

const CLI = path.join(__dirname, 'conformance-cli.js');
const RUN_MEDIA_CONFORMANCE = process.env.CHIPK_RUN_MEDIA_CONFORMANCE === '1';

function tempDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-conformance-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(args, { timeout = 15_000 } = {}) {
  return spawnSync(CLI, args, {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    timeout,
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
  assert.deepEqual(
    capabilities.contractCapabilities[1].presentationProfiles[0].stockIds,
    ['3441'],
  );
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
  const requestPath = writeRequest(root, outputDirectory, { contractVersion: 3 });

  const completed = run(['acquire', '--request', requestPath, '--json']);
  assert.equal(completed.status, 2);
  assert.equal(completed.stdout, '');
  assert.equal(JSON.parse(completed.stderr).error.code, 'UNSUPPORTED_CONTRACT');
  assert.deepEqual(fs.readdirSync(outputDirectory), []);
});

test('conformance driver emits decodable canonical v2 media without Simulator access', {
  skip: RUN_MEDIA_CONFORMANCE
    ? false
    : 'set CHIPK_RUN_MEDIA_CONFORMANCE=1 for the explicit ffmpeg media conformance',
  timeout: 120_000,
}, (t) => {
  const root = tempDirectory(t);
  const outputDirectory = path.join(root, 'output');
  fs.mkdirSync(outputDirectory);
  const requestPath = writeRequest(root, outputDirectory, {
    contractVersion: 2,
    requestId: 'provider-conformance-v2-001',
    operation: 'prepared-video',
    target: { routeId: 'chipk.stock.main-force', stockId: '3441' },
    presentation: { profileId: 'chipk.stock-main-force-portrait.v1' },
  });

  const completed = run(
    ['acquire', '--request', requestPath, '--json'],
    { timeout: 120_000 },
  );
  assert.equal(completed.status, 0, completed.stderr || completed.error?.message);
  assert.equal(completed.stderr, '');
  const result = validateResult(JSON.parse(completed.stdout));
  assert.equal(result.contractVersion, 2);
  assert.equal(result.evidence.material, 'ready_to_place');
  assert.deepEqual(result.artifacts.map(({ role }) => role), [
    'prepared-video', 'screenshot', 'capture-manifest',
    'presentation-plan', 'preparation-manifest',
  ]);
  assert.deepEqual(fs.readdirSync(outputDirectory), ['ready-to-place']);
  for (const artifact of result.artifacts) {
    const artifactPath = path.join(outputDirectory, artifact.relativePath);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
    assert.equal(digest, artifact.sha256);
  }

  const screenshotArtifact = result.artifacts.find(({ role }) => role === 'screenshot');
  const screenshotPath = path.join(outputDirectory, screenshotArtifact.relativePath);
  const screenshotProbe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name,width,height',
    '-of', 'json',
    screenshotPath,
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(screenshotProbe.status, 0, screenshotProbe.stderr);
  assert.deepEqual(JSON.parse(screenshotProbe.stdout).streams[0], {
    codec_name: 'png',
    width: 1206,
    height: 2622,
  });
  const screenshotDecode = spawnSync('ffmpeg', [
    '-v', 'error',
    '-nostdin',
    '-i', screenshotPath,
    '-frames:v', '1',
    '-f', 'null',
    '-',
  ], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(screenshotDecode.status, 0, screenshotDecode.stderr);

  const videoArtifact = result.artifacts.find(({ role }) => role === 'prepared-video');
  const videoPath = path.join(outputDirectory, videoArtifact.relativePath);
  assert.equal(fs.readFileSync(videoPath).subarray(4, 8).toString('ascii'), 'ftyp');
  assert.deepEqual(probeVideo(videoPath), {
    codec: 'h264',
    width: 1206,
    height: 2622,
    durationSeconds: 5,
    fps: 30,
    pixelFormat: 'yuv420p',
    audioStreamCount: 0,
  });
  const preparationManifest = JSON.parse(fs.readFileSync(path.join(
    outputDirectory,
    result.artifacts.find(({ role }) => role === 'preparation-manifest').relativePath,
  )));
  assert.match(preparationManifest.tool.ffmpeg, /^ffmpeg version /);
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
