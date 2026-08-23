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

const reviewedCatalog = readCatalog();

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertFullFocusVisible(cameraPose) {
  const visibleSize = 1 / cameraPose.zoom;
  const viewport = {
    left: cameraPose.centerX - visibleSize / 2,
    right: cameraPose.centerX + visibleSize / 2,
    top: cameraPose.centerY - visibleSize / 2,
    bottom: cameraPose.centerY + visibleSize / 2,
  };
  const epsilon = 0.000001;
  assert.equal(cameraPose.focus.x >= viewport.left - epsilon, true);
  assert.equal(cameraPose.focus.x + cameraPose.focus.width <= viewport.right + epsilon, true);
  assert.equal(cameraPose.focus.y >= viewport.top - epsilon, true);
  assert.equal(cameraPose.focus.y + cameraPose.focus.height <= viewport.bottom + epsilon, true);
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
  const first = buildPreparedPlan(actions, profile, media, reviewedCatalog);
  const second = buildPreparedPlan(
    clone(actions),
    clone(profile),
    { ...media },
    clone(reviewedCatalog),
  );
  assert.deepEqual(second, first);
  const { sha256: _, ...withoutDigest } = first;
  assert.equal(first.sha256, canonicalDigest(withoutDigest));
  assert.equal(first.output.width, 1206);
  assert.equal(first.output.height, 2622);
  assert.equal(first.source.recording.anchorSemantics, actions.recording.anchorSemantics);
  assert.equal(first.source.timing.precisionPreserved, true);
  assert.deepEqual(first.source.routePolicy, {
    catalogVersion: reviewedCatalog.catalogVersion,
    catalogCanonicalSha256: canonicalDigest(reviewedCatalog),
    routeId: 'chipk.stock.kline',
    captureAllowed: true,
    sideEffectRisk: 'none',
    requiresRootNavigation: false,
    verdict: 'capture_allowed_read_only',
    validationBasis: 'validated_against_current_reviewed_catalog_at_preparation',
  });
  assert.equal(first.evidenceBoundary.readyToPlace, 'pending_human_review');
  assert.deepEqual(first.evidenceBoundary.transformation, {
    sourceVisualContent: 'retained_as_visual_source',
    cameraTransform: 'crop_scale_pan_applied',
    interactionOverlays: 'rendered_over_source_visuals',
    pixelIdentityPreserved: false,
    reencode: {
      mode: 'lossy', codec: 'h264', encoder: 'libx264', pixelFormat: 'yuv420p', crf: 18,
    },
  });
});

test('plan distinguishes normal tap, explicit long press, swipe direction/path, and result hold', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const plan = buildPreparedPlan(fixtureActions(), profile, media, reviewedCatalog);
  assert.deepEqual(plan.presentation.interactions.map((item) => item.kind), [
    'tap', 'long_press', 'swipe', 'result_hold',
  ]);
  const swipe = plan.presentation.interactions.find((item) => item.kind === 'swipe');
  assert.equal(swipe.direction, 'left');
  assert.deepEqual(swipe.touchPath.start, { x: 0.8209, y: 0.492 });
  assert.equal(plan.presentation.result.assertionId, 'fixture-result-assert');
  assert.equal(plan.presentation.result.holdId, 'fixture-result-hold');
  assert.equal(plan.presentation.camera.keyframes.at(-1).atMs, 12000);
  assert.equal(plan.presentation.camera.transitionLeadMs, 480);
  const resultHold = plan.presentation.interactions.find((item) => item.kind === 'result_hold');
  assert.equal(resultHold.cameraPose.zoomDecision.profileRequestedZoom, 1.32);
  assert.equal(resultHold.cameraPose.zoomDecision.clamped, true);
  assert.equal(resultHold.cameraPose.zoomDecision.clampReason, 'preserve_full_zoom_focus');
  assert.equal(resultHold.cameraPose.zoom <= 1 / 0.92, true);
  assertFullFocusVisible(resultHold.cameraPose);
  const resultKeyframe = plan.presentation.camera.keyframes.find(
    (keyframe) => keyframe.atMs === resultHold.timing.startedOffsetMs,
  );
  assert.equal(resultKeyframe.zoom, resultHold.cameraPose.zoomDecision.effectiveZoom);
  assert.equal(resultKeyframe.zoom <= 1 / 0.92, true);
});

test('camera preserves the full zoomFocus for wide, tall, and edge-aligned regions', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const actions = fixtureActions();
  const tap = actions.planned.find((action) => action.id === 'fixture-tap');
  tap.zoomFocus = { x: 0.2, y: 0.8, width: 0.3, height: 0.2 };
  const longPress = actions.planned.find((action) => action.id === 'fixture-long-press');
  longPress.zoomFocus = { x: 0.8, y: 0.1, width: 0.2, height: 0.8 };
  const plan = buildPreparedPlan(actions, profile, media, reviewedCatalog);
  for (const interaction of plan.presentation.interactions) {
    assertFullFocusVisible(interaction.cameraPose);
  }
  const tallPose = plan.presentation.interactions.find((item) => item.kind === 'long_press').cameraPose;
  assert.equal(tallPose.zoomDecision.profileRequestedZoom, 1.48);
  assert.equal(tallPose.zoomDecision.maxFocusPreservingZoom, 1.25);
  assert.equal(tallPose.zoomDecision.effectiveZoom, 1.25);
  assert.equal(tallPose.zoomDecision.clamped, true);
});

test('camera remains stable through every interaction window and reserves full transition leads', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const plan = buildPreparedPlan(fixtureActions(), profile, media, reviewedCatalog);
  assert.deepEqual(
    plan.presentation.interactions.map((interaction) => interaction.requiredStableUntilOffsetMs),
    [1080, 4800, 7180, 12000],
  );
  for (const [index, interaction] of plan.presentation.interactions.entries()) {
    const roundedPose = {
      zoom: Number(interaction.cameraPose.zoom.toFixed(6)),
      centerX: Number(interaction.cameraPose.centerX.toFixed(6)),
      centerY: Number(interaction.cameraPose.centerY.toFixed(6)),
    };
    const stableKeyframe = plan.presentation.camera.keyframes.find(
      (keyframe) => keyframe.atMs === interaction.requiredStableUntilOffsetMs,
    );
    assert.deepEqual(
      { zoom: stableKeyframe.zoom, centerX: stableKeyframe.centerX, centerY: stableKeyframe.centerY },
      roundedPose,
    );
    assert.equal(
      plan.presentation.camera.keyframes
        .filter((keyframe) =>
          keyframe.atMs >= interaction.timing.startedOffsetMs &&
          keyframe.atMs <= interaction.requiredStableUntilOffsetMs)
        .every((keyframe) =>
          keyframe.zoom === roundedPose.zoom &&
          keyframe.centerX === roundedPose.centerX &&
          keyframe.centerY === roundedPose.centerY),
      true,
    );
    const nextInteraction = plan.presentation.interactions[index + 1];
    if (nextInteraction) {
      const nextTransitionAt = nextInteraction.timing.startedOffsetMs - profile.camera.leadMs;
      assert.equal(nextTransitionAt >= interaction.requiredStableUntilOffsetMs, true);
    }
  }
});

test('camera accepts an exact full-lead boundary without overwriting the previous hold', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const actions = fixtureActions();
  const longPress = actions.observed.find((event) => event.id === 'fixture-long-press');
  longPress.startedOffsetMs = 1560;
  longPress.completedOffsetMs = 4560;
  const plan = buildPreparedPlan(actions, profile, media, reviewedCatalog);
  const [tap] = plan.presentation.interactions;
  const boundaryKeyframe = plan.presentation.camera.keyframes.find(
    (keyframe) => keyframe.atMs === tap.requiredStableUntilOffsetMs,
  );
  assert.deepEqual(
    { zoom: boundaryKeyframe.zoom, centerX: boundaryKeyframe.centerX, centerY: boundaryKeyframe.centerY },
    {
      zoom: Number(tap.cameraPose.zoom.toFixed(6)),
      centerX: Number(tap.cameraPose.centerX.toFixed(6)),
      centerY: Number(tap.cameraPose.centerY.toFixed(6)),
    },
  );
});

test('camera fails closed for zero-gap and short-gap actions instead of shortening transition lead', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  for (const [startedOffsetMs, availableTransitionLeadMs] of [[1080, 0], [1400, 320]]) {
    const actions = fixtureActions();
    const longPress = actions.observed.find((event) => event.id === 'fixture-long-press');
    longPress.startedOffsetMs = startedOffsetMs;
    longPress.completedOffsetMs = startedOffsetMs + 3000;
    assert.throws(
      () => buildPreparedPlan(actions, profile, media, reviewedCatalog),
      (error) => {
        assert.equal(error.code, 'insufficient_camera_transition_gap');
        assert.equal(error.details.previousActionId, 'fixture-tap');
        assert.equal(error.details.nextActionId, 'fixture-long-press');
        assert.equal(error.details.previousRequiredStableUntilMs, 1080);
        assert.equal(error.details.requiredTransitionLeadMs, 480);
        assert.equal(error.details.availableTransitionLeadMs, availableTransitionLeadMs);
        return true;
      },
    );
  }
});

test('current strict recording recipe compiles without event-id-specific presentation rules', () => {
  const catalog = readCatalog();
  const recipes = readRecipes(catalog);
  const recipePlan = planRecipe(catalog, recipes, 'renbao.kline-main-force-swipe');
  const planned = recipePlan.planned.filter((event) => event.phase === 'in_record');
  const schedules = [
    [600, 1000],
    [1800, 4800],
    [5600, 6500],
    [6800, 7200],
    [8000, 12000],
  ];
  const observed = planned.map((action, index) => ({
      id: action.id,
      status: 'passed',
      startedOffsetMs: schedules[index][0],
      completedOffsetMs: schedules[index][1],
      timingSource: 'synthetic_current_recipe_fixture',
      precision: 'fixture_only',
    }));
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
  const plan = buildPreparedPlan(actions, profile, media, catalog);
  assert.equal(plan.source.recipe.id, 'renbao.kline-main-force-swipe');
  assert.equal(plan.source.routePolicy.routeId, 'chipk.stock.kline');
  assert.equal(plan.source.routePolicy.catalogVersion, catalog.catalogVersion);
  assert.deepEqual(plan.presentation.interactions.map((item) => item.kind), [
    'tap', 'long_press', 'swipe', 'result_hold',
  ]);
  const resultHold = plan.presentation.interactions.find((item) => item.kind === 'result_hold');
  assert.equal(resultHold.cameraPose.zoomDecision.clamped, true);
  assert.equal(resultHold.cameraPose.zoom <= 1 / resultHold.cameraPose.focus.width, true);
  assertFullFocusVisible(resultHold.cameraPose);
});

test('planner rejects unknown, capture-forbidden, and side-effecting routes', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const unknown = fixtureActions();
  unknown.routeId = 'chipk.retired.route';
  assert.throws(
    () => buildPreparedPlan(unknown, profile, media, reviewedCatalog),
    { code: 'unreviewed_route' },
  );

  const forbiddenCatalog = clone(reviewedCatalog);
  forbiddenCatalog.routes.find((route) => route.id === 'chipk.stock.kline').captureAllowed = false;
  assert.throws(
    () => buildPreparedPlan(fixtureActions(), profile, media, forbiddenCatalog),
    { code: 'route_not_capture_allowed' },
  );

  const sideEffectCatalog = clone(reviewedCatalog);
  sideEffectCatalog.routes.find((route) => route.id === 'chipk.stock.kline').sideEffectRisk = 'write';
  assert.throws(
    () => buildPreparedPlan(fixtureActions(), profile, media, sideEffectCatalog),
    { code: 'route_not_read_only' },
  );
});

test('planner fails closed when observed evidence or action geometry is incomplete', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const incomplete = fixtureActions();
  incomplete.timing.observedComplete = false;
  incomplete.timing.missingObservedEventIds = ['fixture-swipe'];
  assert.throws(() => buildPreparedPlan(incomplete, profile, media, reviewedCatalog), {
    code: 'incomplete_action_evidence',
  });

  const noHoldFocus = fixtureActions();
  delete noHoldFocus.planned.find((action) => action.type === 'hold').zoomFocus;
  assert.throws(() => buildPreparedPlan(noHoldFocus, profile, media, reviewedCatalog), {
    code: 'insufficient_action_semantics',
  });

  const noAssertion = fixtureActions();
  noAssertion.planned = noAssertion.planned.filter((action) => action.type !== 'assert');
  noAssertion.observed = noAssertion.observed.filter((event) => event.id !== 'fixture-result-assert');
  assert.throws(() => buildPreparedPlan(noAssertion, profile, media, reviewedCatalog), {
    code: 'incomplete_action_evidence',
  });
});

test('planner never infers a long press from an id or long elapsed timing', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  const ambiguous = fixtureActions();
  const longPress = ambiguous.planned.find((action) => action.id === 'fixture-long-press');
  delete longPress.execution.longPress;
  assert.throws(() => buildPreparedPlan(ambiguous, profile, media, reviewedCatalog), {
    code: 'ambiguous_action_semantics',
  });
});

test('planner rejects landscape, duration mismatch, and touch geometry outside the focused camera', () => {
  const profile = getProfile(profilesFile, 'chipk.full-phone-portrait.v0');
  assert.throws(
    () => buildPreparedPlan(
      fixtureActions(), profile, { ...media, width: 2622, height: 1206 }, reviewedCatalog,
    ),
    { code: 'unsupported_source_media' },
  );
  assert.throws(
    () => buildPreparedPlan(
      fixtureActions(), profile, { ...media, durationSeconds: 11 }, reviewedCatalog,
    ),
    { code: 'source_media_mismatch' },
  );
  const unsafe = fixtureActions();
  const swipe = unsafe.planned.find((action) => action.type === 'swipe');
  swipe.touchPath.start = { x: 0, y: 0 };
  assert.throws(() => buildPreparedPlan(unsafe, profile, media, reviewedCatalog), {
    code: 'unsafe_presentation_geometry',
  });
});
