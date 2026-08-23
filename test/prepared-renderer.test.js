'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const profilesFile = require('../config/presentation-profiles.experimental.json');
const { buildPreparedPlan, getProfile, PreparationError } = require('../src/prepared-plan');
const {
  buildFfmpegFilter,
  normalizeProbe,
  renderPrepared,
} = require('../src/prepared-renderer');
const { parseArgs } = require('../scripts/prepare-mobile-clip');
const { fixtureActions, media } = require('./helpers/prepared-fixture');

function tempDir(t) {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'prepared-mobile-clip-test-'));
  t.after(() => fs.rmSync(result, { recursive: true, force: true }));
  return result;
}

function digest(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function sourceBundle(t) {
  const dir = tempDir(t);
  const raw = path.join(dir, 'fixture-source.bin');
  const actions = path.join(dir, 'fixture-action-sidecar.json');
  const recordingManifest = path.join(dir, 'fixture-recording-evidence.json');
  fs.writeFileSync(raw, 'synthetic-video-bytes');
  const actionValue = fixtureActions();
  writeJson(actions, actionValue);
  writeJson(recordingManifest, {
    schemaVersion: 1,
    recipe: actionValue.recipe,
    recording: {
      codec: media.codec,
      width: media.width,
      height: media.height,
      durationSeconds: media.durationSeconds,
      anchorSemantics: actionValue.recording.anchorSemantics,
      timelineCalibration: actionValue.recording.timelineCalibration,
    },
    artifacts: {
      rawVideo: { file: path.basename(raw), sha256: digest(raw) },
      actions: { file: path.basename(actions), sha256: digest(actions) },
    },
  });
  return { dir, raw, actions, recordingManifest, actionValue };
}

test('filter is deterministic and contains camera, tap, long-press, and swipe primitives', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const plan = buildPreparedPlan(fixtureActions(), profile, media);
  const first = buildFfmpegFilter(plan, profile);
  const second = buildFfmpegFilter(plan, profile);
  assert.equal(second, first);
  assert.match(first, /zoompan=/);
  assert.match(first, /drawbox=/);
  assert.match(first, /between\(t,0\.2,0\.416\)/);
  assert.match(first, /between\(t,1\.8,4\.8\)/);
  assert.equal(first.includes('fixture-tap'), false);
});

test('probe normalizer keeps H.264 media facts without requiring ffmpeg in tests', () => {
  assert.deepEqual(normalizeProbe({
    streams: [{ codec_type: 'video', codec_name: 'h264', width: 1206, height: 2622, avg_frame_rate: '30/1' }],
    format: { duration: '12.000' },
  }), media);
});

test('renderer publishes prepared video, deterministic plan, and provenance atomically with injected media tools', async (t) => {
  const source = sourceBundle(t);
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const destinations = {
    video: path.join(source.dir, 'prepared-output.mp4'),
    plan: path.join(source.dir, 'prepared-output-plan.json'),
    manifest: path.join(source.dir, 'prepared-output-provenance.json'),
  };
  const result = await renderPrepared({
    raw: source.raw,
    actions: source.actions,
    recordingManifest: source.recordingManifest,
    profile,
    ...destinations,
  }, {
    clock: () => Date.parse('2030-01-02T03:04:05.000Z'),
    probeVideo: async () => media,
    runFfmpeg: async (_input, output) => {
      fs.writeFileSync(output, 'synthetic-prepared-video');
      return { version: 'fixture-renderer 1' };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.freshSimulatorCapture, false);
  assert.deepEqual(Object.values(destinations).map((filePath) => fs.existsSync(filePath)), [true, true, true]);
  const plan = JSON.parse(fs.readFileSync(destinations.plan, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(destinations.manifest, 'utf8'));
  assert.equal(manifest.captureDuringPreparation, false);
  assert.equal(manifest.source.provenanceValidation, 'passed');
  assert.equal(manifest.source.rawVideo.sha256, digest(source.raw));
  assert.equal(manifest.source.actions.sha256, digest(source.actions));
  assert.equal(manifest.plan.canonicalSha256, plan.sha256);
  assert.equal(manifest.output.sha256, digest(destinations.video));
  assert.equal(manifest.output.role, 'experimental-prepared-video');
  assert.equal(manifest.review.status, 'pending_human_review');
  assert.equal(manifest.tool.ffmpeg, 'fixture-renderer 1');
});

test('renderer rejects provenance mismatch and publishes nothing', async (t) => {
  const source = sourceBundle(t);
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const sourceManifest = JSON.parse(fs.readFileSync(source.recordingManifest, 'utf8'));
  sourceManifest.artifacts.rawVideo.sha256 = '0'.repeat(64);
  writeJson(source.recordingManifest, sourceManifest);
  const destinations = {
    video: path.join(source.dir, 'no-video.mp4'),
    plan: path.join(source.dir, 'no-plan.json'),
    manifest: path.join(source.dir, 'no-provenance.json'),
  };
  await assert.rejects(
    () => renderPrepared({
      raw: source.raw,
      actions: source.actions,
      recordingManifest: source.recordingManifest,
      profile,
      ...destinations,
    }, { probeVideo: async () => media }),
    { code: 'source_provenance_mismatch' },
  );
  assert.deepEqual(Object.values(destinations).map((filePath) => fs.existsSync(filePath)), [false, false, false]);
});

test('renderer keeps raw, actions, evidence, and prepared outputs in one bundle directory', async (t) => {
  const source = sourceBundle(t);
  const other = tempDir(t);
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  await assert.rejects(
    () => renderPrepared({
      raw: source.raw,
      actions: source.actions,
      recordingManifest: source.recordingManifest,
      profile,
      video: path.join(other, 'prepared.mp4'),
      plan: path.join(other, 'prepared-plan.json'),
      manifest: path.join(other, 'prepared-provenance.json'),
    }, { probeVideo: async () => media }),
    { code: 'input_output_directory_mismatch' },
  );
});

test('renderer failure leaves no partial final bundle', async (t) => {
  const source = sourceBundle(t);
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const destinations = {
    video: path.join(source.dir, 'failed-video.mp4'),
    plan: path.join(source.dir, 'failed-plan.json'),
    manifest: path.join(source.dir, 'failed-provenance.json'),
  };
  await assert.rejects(
    () => renderPrepared({
      raw: source.raw,
      actions: source.actions,
      recordingManifest: source.recordingManifest,
      profile,
      ...destinations,
    }, {
      probeVideo: async () => media,
      runFfmpeg: async () => {
        throw new PreparationError('prepared_render_failed', 'fixture failure');
      },
    }),
    { code: 'prepared_render_failed' },
  );
  assert.deepEqual(Object.values(destinations).map((filePath) => fs.existsSync(filePath)), [false, false, false]);
  assert.equal(fs.readdirSync(source.dir).some((name) => name.startsWith('.prepared-mobile-clip-')), false);
});

test('experimental CLI parser rejects undeclared flags and keeps stable CLI untouched', () => {
  assert.deepEqual(parseArgs(['profile-check', '--json']).values.json, true);
  assert.throws(() => parseArgs(['render', '--udid', 'fixture']), { code: 'unknown_flag' });
});
