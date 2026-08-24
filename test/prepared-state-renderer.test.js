'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profilesFile = require('../config/presentation-profiles.json');
const { getProfile } = require('../src/presentation-profiles');
const { buildFfmpegFilter, buildPresentationPlan } = require('../src/prepared-state-renderer');

const profile = getProfile(profilesFile, 'chipk.stock-main-force-portrait.v1');

test('screenshot-state filter is deterministic, 30fps, and contains camera only', () => {
  const media = { width: 1206, height: 2622 };
  const first = buildFfmpegFilter(profile, media);
  const second = buildFfmpegFilter(profile, media);
  assert.equal(second, first);
  assert.match(first, /zoompan=/);
  assert.match(first, /fps=30/);
  assert.match(first, /trim=duration=5/);
  assert.doesNotMatch(first, /drawbox=/);
});

test('presentation plan preserves the fresh screenshot and has no invented interaction', () => {
  const plan = buildPresentationPlan({
    request: { requestId: 'prepared-state-plan-test', mode: 'test' },
    profile,
    capturePlan: {
      route: { id: 'chipk.stock.main-force' },
      parameters: { stockid: '3441', stockname: '聯一光' },
    },
    source: {
      screenshotSha256: 'a'.repeat(64),
      captureManifestSha256: 'b'.repeat(64),
    },
    media: { width: 1206, height: 2622 },
  });
  assert.equal(plan.target.routeId, 'chipk.stock.main-force');
  assert.equal(plan.requestId, 'prepared-state-plan-test');
  assert.equal(plan.target.stockId, '3441');
  assert.equal(plan.timeline.frameCount, 150);
  assert.deepEqual(plan.presentation.interactions, []);
  assert.equal(plan.output.audio, 'none');
  assert.match(plan.canonicalSha256, /^[a-f0-9]{64}$/);
});
