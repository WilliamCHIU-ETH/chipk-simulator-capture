'use strict';

const crypto = require('node:crypto');

const PREPARED_PLAN_SCHEMA_VERSION = 1;
const PLANNER_ID = 'chipk-prepared-plan';
const PLANNER_VERSION = 1;
const PROFILE_ROOT_KEYS = new Set(['schemaVersion', 'status', 'profiles']);
const PROFILE_KEYS = new Set([
  'id', 'version', 'status', 'output', 'camera', 'emphasis', 'requirements',
]);
const OUTPUT_KEYS = new Set([
  'dimensions', 'orientation', 'codec', 'encoder', 'pixelFormat', 'fps', 'crf', 'preset',
]);
const CAMERA_KEYS = new Set(['easing', 'leadMs', 'maxZoom', 'zoomByKind']);
const EMPHASIS_KEYS = new Set([
  'tapPulseMs', 'longPressMinimumMs', 'resultHoldMinimumMs', 'swipeTrailSamples',
  'swipeTrailHoldMs', 'markerSizeRatio', 'color',
]);
const REQUIREMENT_KEYS = new Set([
  'observedComplete', 'requiredInteractionKinds', 'requiredEvidenceTypes', 'maxDurationMs',
  'timelineToleranceMs',
]);
const ZOOM_KINDS = Object.freeze(['tap', 'long_press', 'swipe', 'result_hold']);
const INTERACTION_TYPES = new Set(['tap', 'swipe', 'assert', 'hold']);

class PreparationError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'PreparationError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function fail(code, message, details) {
  throw new PreparationError(code, message, details);
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  if (!isObject(value)) fail('invalid_profile', `${label} 必須是 object`);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    fail('invalid_profile', `${label} 含未宣告欄位`, { unknownKeys: unknown });
  }
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_preparation_input', `${label} 必須是有限數字`);
  }
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail('invalid_profile', `${label} 必須是 ${min}..${max} 的整數`);
  }
  return value;
}

function numberInRange(value, label, min, max, code = 'invalid_profile') {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    fail(code, `${label} 必須介於 ${min}..${max}`);
  }
  return value;
}

function requireString(value, label, code = 'invalid_profile') {
  if (typeof value !== 'string' || value.length === 0) fail(code, `${label} 必須是非空字串`);
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

function canonicalDigest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

function validateStringArray(value, label, allowed) {
  if (!Array.isArray(value) || value.length === 0 || new Set(value).size !== value.length) {
    fail('invalid_profile', `${label} 必須是非空且不重複的陣列`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.has(item)) {
      fail('invalid_profile', `${label} 含不支援的值`);
    }
  }
}

function validateProfile(profile, label) {
  rejectUnknownKeys(profile, PROFILE_KEYS, label);
  requireString(profile.id, `${label}.id`);
  integer(profile.version, `${label}.version`, 1, Number.MAX_SAFE_INTEGER);
  if (profile.status !== 'experimental') fail('invalid_profile', `${label}.status 必須是 experimental`);

  rejectUnknownKeys(profile.output, OUTPUT_KEYS, `${label}.output`);
  const expectedOutput = {
    dimensions: 'preserve_source',
    orientation: 'portrait',
    codec: 'h264',
    encoder: 'libx264',
    pixelFormat: 'yuv420p',
    fps: 'source_or_30',
  };
  for (const [key, expected] of Object.entries(expectedOutput)) {
    if (profile.output[key] !== expected) {
      fail('invalid_profile', `${label}.output.${key} 必須是 ${expected}`);
    }
  }
  integer(profile.output.crf, `${label}.output.crf`, 0, 51);
  if (!new Set(['ultrafast', 'veryfast', 'fast', 'medium', 'slow']).has(profile.output.preset)) {
    fail('invalid_profile', `${label}.output.preset 不支援`);
  }

  rejectUnknownKeys(profile.camera, CAMERA_KEYS, `${label}.camera`);
  if (profile.camera.easing !== 'cosine') {
    fail('invalid_profile', `${label}.camera.easing 必須是 cosine`);
  }
  integer(profile.camera.leadMs, `${label}.camera.leadMs`, 80, 1000);
  numberInRange(profile.camera.maxZoom, `${label}.camera.maxZoom`, 1, 3);
  rejectUnknownKeys(profile.camera.zoomByKind, new Set(ZOOM_KINDS), `${label}.camera.zoomByKind`);
  for (const kind of ZOOM_KINDS) {
    numberInRange(profile.camera.zoomByKind[kind], `${label}.camera.zoomByKind.${kind}`, 1, profile.camera.maxZoom);
  }

  rejectUnknownKeys(profile.emphasis, EMPHASIS_KEYS, `${label}.emphasis`);
  integer(profile.emphasis.tapPulseMs, `${label}.emphasis.tapPulseMs`, 160, 1000);
  integer(profile.emphasis.longPressMinimumMs, `${label}.emphasis.longPressMinimumMs`, 800, 5000);
  integer(profile.emphasis.resultHoldMinimumMs, `${label}.emphasis.resultHoldMinimumMs`, 400, 5000);
  integer(profile.emphasis.swipeTrailSamples, `${label}.emphasis.swipeTrailSamples`, 3, 16);
  integer(profile.emphasis.swipeTrailHoldMs, `${label}.emphasis.swipeTrailHoldMs`, 0, 1000);
  numberInRange(profile.emphasis.markerSizeRatio, `${label}.emphasis.markerSizeRatio`, 0.005, 0.05);
  if (!/^0x[0-9a-f]{6}$/i.test(profile.emphasis.color || '')) {
    fail('invalid_profile', `${label}.emphasis.color 必須是 0xRRGGBB`);
  }

  rejectUnknownKeys(profile.requirements, REQUIREMENT_KEYS, `${label}.requirements`);
  if (profile.requirements.observedComplete !== true) {
    fail('invalid_profile', `${label}.requirements.observedComplete 必須是 true`);
  }
  validateStringArray(
    profile.requirements.requiredInteractionKinds,
    `${label}.requirements.requiredInteractionKinds`,
    new Set(['tap', 'long_press', 'swipe', 'result_hold']),
  );
  validateStringArray(
    profile.requirements.requiredEvidenceTypes,
    `${label}.requirements.requiredEvidenceTypes`,
    new Set(['assert']),
  );
  integer(profile.requirements.maxDurationMs, `${label}.requirements.maxDurationMs`, 1000, 120000);
  integer(profile.requirements.timelineToleranceMs, `${label}.requirements.timelineToleranceMs`, 0, 1000);
  return profile;
}

function validateProfilesFile(value) {
  rejectUnknownKeys(value, PROFILE_ROOT_KEYS, 'presentation profiles');
  if (value.schemaVersion !== 1 || value.status !== 'experimental') {
    fail('invalid_profile', 'presentation profiles 必須是 experimental schemaVersion 1');
  }
  if (!Array.isArray(value.profiles) || value.profiles.length !== 1) {
    fail('invalid_profile', 'v0 必須只含一個 presentation profile');
  }
  const ids = new Set();
  value.profiles.forEach((profile, index) => {
    validateProfile(profile, `profiles[${index}]`);
    if (ids.has(profile.id)) fail('invalid_profile', `重複 profile id：${profile.id}`);
    ids.add(profile.id);
  });
  return value;
}

function getProfile(value, profileId) {
  validateProfilesFile(value);
  const profile = value.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) fail('unknown_profile', `未知 presentation profile：${profileId}`);
  return profile;
}

function normalizedPoint(value, label) {
  if (!isObject(value)) fail('insufficient_action_semantics', `${label} 缺少 normalized point`);
  const x = numberInRange(value.x, `${label}.x`, 0, 1, 'insufficient_action_semantics');
  const y = numberInRange(value.y, `${label}.y`, 0, 1, 'insufficient_action_semantics');
  return { x, y };
}

function normalizedFocus(value, label) {
  if (!isObject(value)) fail('insufficient_action_semantics', `${label} 缺少 zoomFocus`);
  const x = numberInRange(value.x, `${label}.x`, 0, 1, 'insufficient_action_semantics');
  const y = numberInRange(value.y, `${label}.y`, 0, 1, 'insufficient_action_semantics');
  const width = numberInRange(value.width, `${label}.width`, Number.EPSILON, 1, 'insufficient_action_semantics');
  const height = numberInRange(value.height, `${label}.height`, Number.EPSILON, 1, 'insufficient_action_semantics');
  if (x + width > 1 || y + height > 1) {
    fail('insufficient_action_semantics', `${label} 超出 normalized frame`);
  }
  return { x, y, width, height };
}

function validateMedia(media, profile) {
  if (!isObject(media)) fail('invalid_preparation_input', 'source media probe 缺失');
  if (String(media.codec || '').toLowerCase() !== 'h264') {
    fail('unsupported_source_media', 'raw video 必須是 H.264');
  }
  const width = integerMedia(media.width, 'sourceMedia.width');
  const height = integerMedia(media.height, 'sourceMedia.height');
  if (width >= height) fail('unsupported_source_media', 'v0 只支援直式 full-phone video');
  if (width % 2 !== 0 || height % 2 !== 0) {
    fail('unsupported_source_media', 'H.264 yuv420p output 需要偶數 dimensions');
  }
  const durationSeconds = numberInRange(
    media.durationSeconds,
    'sourceMedia.durationSeconds',
    Number.EPSILON,
    profile.requirements.maxDurationMs / 1000,
    'unsupported_source_media',
  );
  const fps = media.fps === null || media.fps === undefined
    ? 30
    : numberInRange(media.fps, 'sourceMedia.fps', 1, 120, 'unsupported_source_media');
  return { codec: 'h264', width, height, durationSeconds, fps };
}

function integerMedia(value, label) {
  if (!Number.isInteger(value) || value <= 0) fail('unsupported_source_media', `${label} 必須是正整數`);
  return value;
}

function actionKind(action) {
  if (action.type === 'tap') return action.execution?.longPress === true ? 'long_press' : 'tap';
  if (action.type === 'swipe') return 'swipe';
  if (action.type === 'hold') return 'result_hold';
  return action.type;
}

function eventTiming(action, observed, durationMs, toleranceMs, profile) {
  if (!observed || observed.status !== 'passed') {
    fail('incomplete_action_evidence', `${action.id} 缺少 passed observed evidence`);
  }
  const startedOffsetMs = finiteNumber(observed.startedOffsetMs, `${action.id}.startedOffsetMs`);
  const completedOffsetMs = finiteNumber(observed.completedOffsetMs, `${action.id}.completedOffsetMs`);
  if (startedOffsetMs < 0 || completedOffsetMs < startedOffsetMs || completedOffsetMs > durationMs + toleranceMs) {
    fail('invalid_action_timeline', `${action.id} observed timing 超出 raw timeline`);
  }
  const elapsedMs = completedOffsetMs - startedOffsetMs;
  const kind = actionKind(action);
  if (kind === 'long_press' && elapsedMs < profile.emphasis.longPressMinimumMs) {
    fail('incomplete_action_evidence', `${action.id} 標示 long press，但 observed duration 不足`);
  }
  if (kind === 'tap' && elapsedMs >= profile.emphasis.longPressMinimumMs) {
    fail(
      'ambiguous_action_semantics',
      `${action.id} 的 observed duration 像 long press，但 planned action 沒有 execution.longPress`,
    );
  }
  return {
    startedOffsetMs,
    completedOffsetMs: Math.min(completedOffsetMs, durationMs),
    elapsedMs,
    timingSource: requireString(observed.timingSource, `${action.id}.timingSource`, 'incomplete_action_evidence'),
    precision: requireString(observed.precision, `${action.id}.precision`, 'incomplete_action_evidence'),
  };
}

function cameraPose(action, kind, profile) {
  const focus = normalizedFocus(action.zoomFocus, `${action.id}.zoomFocus`);
  const zoom = profile.camera.zoomByKind[kind];
  const visibleWidth = 1 / zoom;
  const visibleHeight = 1 / zoom;
  const desiredCenterX = focus.x + focus.width / 2;
  const desiredCenterY = focus.y + focus.height / 2;
  const centerX = Math.min(1 - visibleWidth / 2, Math.max(visibleWidth / 2, desiredCenterX));
  const centerY = Math.min(1 - visibleHeight / 2, Math.max(visibleHeight / 2, desiredCenterY));
  return { zoom, centerX, centerY, focus };
}

function projectPoint(point, pose, label) {
  const visibleSize = 1 / pose.zoom;
  const left = pose.centerX - visibleSize / 2;
  const top = pose.centerY - visibleSize / 2;
  const x = (point.x - left) / visibleSize;
  const y = (point.y - top) / visibleSize;
  const epsilon = 0.000001;
  if (x < -epsilon || x > 1 + epsilon || y < -epsilon || y > 1 + epsilon) {
    fail('unsafe_presentation_geometry', `${label} 會在 zoom 後離開畫面`);
  }
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

function swipeDirection(start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    fail('insufficient_action_semantics', 'swipe path 起點與終點不可相同');
  }
  return Math.abs(dx) >= Math.abs(dy)
    ? (dx < 0 ? 'left' : 'right')
    : (dy < 0 ? 'up' : 'down');
}

function appendKeyframe(keyframes, keyframe) {
  const previous = keyframes.at(-1);
  if (previous && keyframe.atMs < previous.atMs) {
    fail('invalid_action_timeline', 'camera keyframe timeline 倒退');
  }
  const rounded = {
    atMs: Math.round(keyframe.atMs),
    zoom: Number(keyframe.zoom.toFixed(6)),
    centerX: Number(keyframe.centerX.toFixed(6)),
    centerY: Number(keyframe.centerY.toFixed(6)),
  };
  if (previous && rounded.atMs === previous.atMs) keyframes[keyframes.length - 1] = rounded;
  else keyframes.push(rounded);
}

function buildPreparedPlan(actions, profile, mediaInput) {
  validateProfile(profile, 'profile');
  if (!isObject(actions) || actions.schemaVersion !== 1) {
    fail('invalid_preparation_input', 'actions 必須是 schemaVersion 1');
  }
  if (!isObject(actions.recipe)) fail('invalid_preparation_input', 'actions.recipe 缺失');
  requireString(actions.recipe.id, 'actions.recipe.id', 'invalid_preparation_input');
  if (!Number.isInteger(actions.recipe.version) || actions.recipe.version < 1) {
    fail('invalid_preparation_input', 'actions.recipe.version 必須是正整數');
  }
  if (!/^[0-9a-f]{64}$/i.test(actions.recipe.sha256 || '')) {
    fail('invalid_preparation_input', 'actions.recipe.sha256 必須是 SHA-256');
  }
  requireString(actions.routeId, 'actions.routeId', 'invalid_preparation_input');
  if (!Array.isArray(actions.planned) || !Array.isArray(actions.observed)) {
    fail('invalid_preparation_input', 'actions.planned/observed 必須是陣列');
  }
  if (
    actions.timing?.observedComplete !== true ||
    !Array.isArray(actions.timing?.missingObservedEventIds) ||
    actions.timing.missingObservedEventIds.length !== 0
  ) {
    fail('incomplete_action_evidence', 'actions observed timing 不完整');
  }
  const anchorSemantics = requireString(
    actions.recording?.anchorSemantics,
    'actions.recording.anchorSemantics',
    'incomplete_action_evidence',
  );
  const observedSemantics = requireString(
    actions.timing?.observedSemantics,
    'actions.timing.observedSemantics',
    'incomplete_action_evidence',
  );
  if (!isObject(actions.recording?.timelineCalibration)) {
    fail('incomplete_action_evidence', 'actions.recording.timelineCalibration 缺失');
  }
  requireString(
    actions.recording.timelineCalibration.method,
    'actions.recording.timelineCalibration.method',
    'incomplete_action_evidence',
  );
  requireString(
    actions.recording.timelineCalibration.precision,
    'actions.recording.timelineCalibration.precision',
    'incomplete_action_evidence',
  );
  const media = validateMedia(mediaInput, profile);
  const durationMs = Math.round(media.durationSeconds * 1000);
  const encodedDurationMs = finiteNumber(actions.recording?.encodedDurationMs, 'actions.recording.encodedDurationMs');
  if (Math.abs(encodedDurationMs - durationMs) > profile.requirements.timelineToleranceMs) {
    fail('source_media_mismatch', 'actions encoded duration 與 raw video 不一致');
  }

  for (const action of actions.planned) {
    const allowedPreRecord =
      new Set(['navigation', 'readiness']).has(action?.type) && action?.phase === 'pre_record';
    if (!INTERACTION_TYPES.has(action?.type) && !allowedPreRecord) {
      fail('unsupported_action_semantics', `不支援 planned action type：${action?.type || 'missing'}`);
    }
  }
  const planned = actions.planned.filter((action) => INTERACTION_TYPES.has(action.type));
  const plannedIds = new Set();
  for (const action of planned) {
    if (!isObject(action)) fail('invalid_preparation_input', 'planned action 必須是 object');
    requireString(action.id, 'planned action id', 'invalid_preparation_input');
    if (plannedIds.has(action.id)) fail('invalid_preparation_input', `重複 planned action id：${action.id}`);
    plannedIds.add(action.id);
  }
  const observedById = new Map();
  for (const event of actions.observed) {
    if (!isObject(event) || typeof event.id !== 'string' || observedById.has(event.id)) {
      fail('invalid_preparation_input', 'observed action id 缺失或重複');
    }
    observedById.set(event.id, event);
  }

  const compiled = planned.map((action) => {
    const kind = actionKind(action);
    const timing = eventTiming(
      action,
      observedById.get(action.id),
      durationMs,
      profile.requirements.timelineToleranceMs,
      profile,
    );
    return { action, kind, timing };
  });
  const kinds = new Set(compiled.map((entry) => entry.kind));
  for (const required of profile.requirements.requiredInteractionKinds) {
    if (!kinds.has(required)) fail('insufficient_action_semantics', `actions 缺少 ${required}`);
  }
  for (const required of profile.requirements.requiredEvidenceTypes) {
    if (!kinds.has(required)) fail('incomplete_action_evidence', `actions 缺少 ${required} result evidence`);
  }

  compiled.sort((a, b) => a.timing.startedOffsetMs - b.timing.startedOffsetMs);
  for (let index = 1; index < compiled.length; index += 1) {
    if (compiled[index].timing.startedOffsetMs < compiled[index - 1].timing.completedOffsetMs) {
      fail('invalid_action_timeline', 'observed actions 不可重疊');
    }
  }
  const finalHold = [...compiled].reverse().find((entry) => entry.kind === 'result_hold');
  if (!finalHold || compiled.at(-1) !== finalHold) {
    fail('incomplete_action_evidence', '最後一個 observed action 必須是 result hold');
  }
  const resultAssert = [...compiled]
    .filter((entry) => entry.kind === 'assert' && entry.timing.completedOffsetMs <= finalHold.timing.startedOffsetMs)
    .at(-1);
  if (!resultAssert) fail('incomplete_action_evidence', 'result hold 前缺少 passed assert evidence');
  if (finalHold.timing.elapsedMs < profile.emphasis.resultHoldMinimumMs) {
    fail('incomplete_action_evidence', 'result hold observed duration 不足');
  }

  const cameraEntries = compiled.filter((entry) =>
    new Set(['tap', 'long_press', 'swipe', 'result_hold']).has(entry.kind));
  const keyframes = [{ atMs: 0, zoom: 1, centerX: 0.5, centerY: 0.5 }];
  const interactions = [];
  let previousRequiredStableUntilMs = 0;
  let previousActionId = 'composition_start';
  let previousPose = { zoom: 1, centerX: 0.5, centerY: 0.5 };
  for (const entry of cameraEntries) {
    const { action, kind, timing } = entry;
    const pose = cameraPose(action, kind, profile);
    const base = {
      id: action.id,
      kind,
      timing,
      cameraPose: pose,
    };
    let interaction;
    let requiredStableUntilOffsetMs;
    if (kind === 'tap' || kind === 'long_press') {
      const touchPoint = normalizedPoint(action.touchPoint, `${action.id}.touchPoint`);
      const emphasisEndOffsetMs = kind === 'tap'
        ? timing.startedOffsetMs + profile.emphasis.tapPulseMs
        : timing.completedOffsetMs;
      requiredStableUntilOffsetMs = emphasisEndOffsetMs;
      interaction = {
        ...base,
        touchPoint,
        screenPoint: projectPoint(touchPoint, pose, `${action.id}.touchPoint`),
        emphasisEndOffsetMs,
        requiredStableUntilOffsetMs,
      };
    } else if (kind === 'swipe') {
      const start = normalizedPoint(action.touchPath?.start, `${action.id}.touchPath.start`);
      const end = normalizedPoint(action.touchPath?.end, `${action.id}.touchPath.end`);
      requiredStableUntilOffsetMs = timing.completedOffsetMs + profile.emphasis.swipeTrailHoldMs;
      interaction = {
        ...base,
        touchPath: { start, end },
        screenPath: {
          start: projectPoint(start, pose, `${action.id}.touchPath.start`),
          end: projectPoint(end, pose, `${action.id}.touchPath.end`),
        },
        direction: swipeDirection(start, end),
        requiredStableUntilOffsetMs,
      };
    } else {
      requiredStableUntilOffsetMs = timing.completedOffsetMs;
      interaction = { ...base, requiredStableUntilOffsetMs };
    }

    const transitionStartMs = timing.startedOffsetMs - profile.camera.leadMs;
    if (transitionStartMs < previousRequiredStableUntilMs) {
      fail(
        'insufficient_camera_transition_gap',
        `${action.id} 前沒有完整且不干擾上一個 action 的 camera transition lead`,
        {
          previousActionId,
          nextActionId: action.id,
          previousRequiredStableUntilMs,
          nextActionStartedOffsetMs: timing.startedOffsetMs,
          requiredTransitionLeadMs: profile.camera.leadMs,
          availableTransitionLeadMs: timing.startedOffsetMs - previousRequiredStableUntilMs,
        },
      );
    }
    appendKeyframe(keyframes, { atMs: transitionStartMs, ...previousPose });
    appendKeyframe(keyframes, { atMs: timing.startedOffsetMs, ...pose });
    appendKeyframe(keyframes, { atMs: requiredStableUntilOffsetMs, ...pose });
    interactions.push(interaction);
    previousRequiredStableUntilMs = requiredStableUntilOffsetMs;
    previousActionId = action.id;
    previousPose = pose;
  }
  appendKeyframe(keyframes, { atMs: durationMs, ...previousPose });

  const profileSha256 = canonicalDigest(profile);
  const planWithoutDigest = {
    experimentalSchemaVersion: PREPARED_PLAN_SCHEMA_VERSION,
    status: 'experimental',
    planner: { id: PLANNER_ID, version: PLANNER_VERSION },
    profile: { id: profile.id, version: profile.version, sha256: profileSha256 },
    source: {
      actionsCanonicalSha256: canonicalDigest(actions),
      recipe: {
        id: actions.recipe.id,
        version: actions.recipe.version,
        sha256: actions.recipe.sha256,
      },
      routeId: actions.routeId,
      recording: {
        encodedDurationMs,
        anchorSemantics,
        timelineCalibration: actions.recording.timelineCalibration,
      },
      timing: {
        observedSemantics,
        precisionPreserved: true,
      },
      media,
    },
    output: {
      width: media.width,
      height: media.height,
      fps: media.fps,
      codec: profile.output.codec,
      encoder: profile.output.encoder,
      pixelFormat: profile.output.pixelFormat,
      durationMs,
    },
    presentation: {
      camera: {
        easing: profile.camera.easing,
        transitionLeadMs: profile.camera.leadMs,
        keyframes,
      },
      interactions,
      result: {
        assertionId: resultAssert.action.id,
        holdId: finalHold.action.id,
        holdStartedOffsetMs: finalHold.timing.startedOffsetMs,
        holdCompletedOffsetMs: finalHold.timing.completedOffsetMs,
      },
    },
    evidenceBoundary: {
      readyToPlace: 'pending_human_review',
      timing: 'preserves upstream precision and does not claim frame-accurate touch timing',
      transformation: {
        sourceVisualContent: 'retained_as_visual_source',
        cameraTransform: 'crop_scale_pan_applied',
        interactionOverlays: 'rendered_over_source_visuals',
        pixelIdentityPreserved: false,
        reencode: {
          mode: 'lossy',
          codec: profile.output.codec,
          encoder: profile.output.encoder,
          pixelFormat: profile.output.pixelFormat,
          crf: profile.output.crf,
        },
      },
      excluded: ['captions', 'music', 'device_shell', 'marketing_scene_layout', 'manual_per_clip_keyframes'],
    },
  };
  return { ...planWithoutDigest, sha256: canonicalDigest(planWithoutDigest) };
}

module.exports = {
  PLANNER_ID,
  PLANNER_VERSION,
  PREPARED_PLAN_SCHEMA_VERSION,
  PreparationError,
  buildPreparedPlan,
  canonicalDigest,
  getProfile,
  validateProfilesFile,
};
