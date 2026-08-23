'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const profilesFile = require('../config/presentation-profiles.experimental.json');
const { readCatalog } = require('../scripts/simulator-capture');
const { planRecipe, readRecipes } = require('../scripts/simulator-record');
const {
  buildPreparedPlan,
  canonicalDigest,
  getProfile,
  validateProfilesFile,
} = require('../src/prepared-plan');
const { fixtureActions, media } = require('./helpers/prepared-fixture');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('experimental profiles file is closed and contains one full-phone profile', () => {
  const result = validateProfilesFile(clone(profilesFile));
  assert.equal(result.status, 'experimental');
  assert.deepEqual(result.profiles.map((profile) => profile.id), [
    'chipk.full-phone-portrait.v0',
  ]);
  assert.equal(result.profiles[0].output.dimensions, 'preserve_source');
  assert.equal(Object.hasOwn(result.profiles[0], 'eventOverrides'), false);
});

test('pure planner is deterministic and preserves source geometry and upstream timing semantics', () => {
  const profile = getProfile(clone(profilesFile), 'chipk.full-phone-portrait.v0');
  const actions = fixtureActions();
  const first = buildPreparedPlan(actions, profile, media);
  const second = buildPreparedPlan(clone(actions), clone(profile), { ...media });
  assert.deepEqual(second, first);
  const { sha256: _, ...withoutDigest } = first;
  assert.equal(first.sha256, canonicalDigest(withoutDigest));
  assert.equal(first.output.width, 1206);
  assert.equal(first.output.height, 2622);
  assert.equal(first.source.recording.anchorSemantics, actions.recording.anchorSemantics);
  assert.equal(first.source.timing.precisionPreserved, true);
  assert.equal(first.evidenceBoundary.readyToPlace, 'pending_human_review');
});

test('plan distinguishes normal tap, explicit long press, swipe direction/path, and result hold', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const plan = buildPreparedPlan(fixtureActions(), profile, media);
  assert.deepEqual(plan.presentation.interactions.map((item) => item.kind), [
    'tap', 'long_press', 'swipe', 'result_hold',
  ]);
  const swipe = plan.presentation.interactions.find((item) => item.kind === 'swipe');
  assert.equal(swipe.direction, 'left');
  assert.deepEqual(swipe.touchPath.start, { x: 0.8209, y: 0.492 });
  assert.equal(plan.presentation.result.assertionId, 'fixture-result-assert');
  assert.equal(plan.presentation.result.holdId, 'fixture-result-hold');
  assert.equal(plan.presentation.camera.keyframes.at(-1).atMs, 12000);
});

test('current strict recording recipe compiles without event-id-specific presentation rules', () => {
  const catalog = readCatalog();
  const recipes = readRecipes(catalog);
  const recipePlan = planRecipe(catalog, recipes, 'renbao.kline-main-force-swipe');
  const planned = recipePlan.planned.filter((event) => event.phase === 'in_record');
  let cursor = 300;
  const observed = planned.map((action) => {
    const elapsed = action.type === 'hold'
      ? 2500
      : action.execution?.longPress === true
        ? 3000
        : action.type === 'swipe'
          ? 900
          : 400;
    const event = {
      id: action.id,
      status: 'passed',
      startedOffsetMs: cursor,
      completedOffsetMs: cursor + elapsed,
      timingSource: 'synthetic_current_recipe_fixture',
      precision: 'fixture_only',
    };
    cursor += elapsed + 300;
    return event;
  });
  const lastHold = observed.at(-1);
  lastHold.completedOffsetMs = 12000;
  const actions = {
    schemaVersion: 1,
    recipe: recipePlan.recipe,
    routeId: recipePlan.route.id,
    recording: {
      encodedDurationMs: 12000,
      anchorSemantics: 'synthetic_fixture_not_first_video_frame',
      timelineCalibration: { method: 'synthetic_fixture', precision: 'fixture_only' },
    },
    timing: {
      observedComplete: true,
      missingObservedEventIds: [],
      observedSemantics: 'synthetic_current_recipe_timing',
    },
    planned,
    observed,
  };
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const plan = buildPreparedPlan(actions, profile, media);
  assert.equal(plan.source.recipe.id, 'renbao.kline-main-force-swipe');
  assert.deepEqual(plan.presentation.interactions.map((item) => item.kind), [
    'tap', 'long_press', 'swipe', 'result_hold',
  ]);
});

test('planner fails closed when observed evidence or action geometry is incomplete', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const incomplete = fixtureActions();
  incomplete.timing.observedComplete = false;
  incomplete.timing.missingObservedEventIds = ['fixture-swipe'];
  assert.throws(() => buildPreparedPlan(incomplete, profile, media), {
    code: 'incomplete_action_evidence',
  });

  const noHoldFocus = fixtureActions();
  delete noHoldFocus.planned.find((action) => action.type === 'hold').zoomFocus;
  assert.throws(() => buildPreparedPlan(noHoldFocus, profile, media), {
    code: 'insufficient_action_semantics',
  });

  const noAssertion = fixtureActions();
  noAssertion.planned = noAssertion.planned.filter((action) => action.type !== 'assert');
  noAssertion.observed = noAssertion.observed.filter((event) => event.id !== 'fixture-result-assert');
  assert.throws(() => buildPreparedPlan(noAssertion, profile, media), {
    code: 'incomplete_action_evidence',
  });
});

test('planner never infers a long press from an id or long elapsed timing', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const ambiguous = fixtureActions();
  const longPress = ambiguous.planned.find((action) => action.id === 'fixture-long-press');
  delete longPress.execution.longPress;
  assert.throws(() => buildPreparedPlan(ambiguous, profile, media), {
    code: 'ambiguous_action_semantics',
  });
});

test('planner rejects landscape, duration mismatch, and touch geometry outside the focused camera', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  assert.throws(
    () => buildPreparedPlan(fixtureActions(), profile, { ...media, width: 2622, height: 1206 }),
    { code: 'unsupported_source_media' },
  );
  assert.throws(
    () => buildPreparedPlan(fixtureActions(), profile, { ...media, durationSeconds: 11 }),
    { code: 'source_media_mismatch' },
  );
  const unsafe = fixtureActions();
  const swipe = unsafe.planned.find((action) => action.type === 'swipe');
  swipe.touchPath.start = { x: 0, y: 0 };
  assert.throws(() => buildPreparedPlan(unsafe, profile, media), {
    code: 'unsafe_presentation_geometry',
  });
});
