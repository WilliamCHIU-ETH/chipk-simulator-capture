'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ContractError } = require('./errors');
const { parseJsonStrict } = require('./strict-json');

const PROFILES_PATH = path.join(__dirname, '..', 'config', 'presentation-profiles.json');
const PROFILE_ID = 'chipk.stock-main-force-portrait.v1';
const PROFILE_KEYS = new Set([
  'id', 'version', 'status', 'sourceKind', 'routeIds', 'stockIds', 'durationSeconds', 'fps',
  'camera', 'interactions', 'output',
]);
const CAMERA_KEYS = new Set(['strategy', 'keyframes']);
const KEYFRAME_KEYS = new Set(['atSeconds', 'zoom', 'centerX', 'centerY']);
const OUTPUT_KEYS = new Set(['codec', 'encoder', 'pixelFormat', 'preset', 'crf', 'audio']);
const PROFILE_CAPABILITY_KEYS = new Set([
  'id', 'version', 'status', 'sourceKind', 'routeIds', 'stockIds', 'artifactRole',
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new ContractError('INVALID_PRESENTATION_PROFILE', `${label} contains unsupported field: ${key}`);
  }
}

function requireRecord(value, label) {
  if (!isRecord(value)) throw new ContractError('INVALID_PRESENTATION_PROFILE', `${label} must be an object`);
  return value;
}

function requireExactStrings(value, expected, label) {
  if (!Array.isArray(value) || value.length !== expected.length
    || value.some((item, index) => item !== expected[index])) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', `${label} does not match the reviewed vertical slice`);
  }
  return Object.freeze([...value]);
}

function validateProfile(input) {
  requireRecord(input, 'profile');
  rejectUnknownKeys(input, PROFILE_KEYS, 'profile');
  if (input.id !== PROFILE_ID || input.version !== 1 || input.status !== 'ready_to_place'
    || input.sourceKind !== 'screenshot') {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'profile identity or status is unsupported');
  }
  const routeIds = requireExactStrings(input.routeIds, ['chipk.stock.main-force'], 'profile.routeIds');
  const stockIds = requireExactStrings(input.stockIds, ['3441'], 'profile.stockIds');
  if (input.durationSeconds !== 5 || input.fps !== 30) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'profile durationSeconds and fps must be 5 and 30');
  }
  if (!Array.isArray(input.interactions) || input.interactions.length !== 0) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'screenshot-state profile interactions must be empty');
  }

  requireRecord(input.camera, 'profile.camera');
  rejectUnknownKeys(input.camera, CAMERA_KEYS, 'profile.camera');
  if (input.camera.strategy !== 'full_to_static_focus'
    || !Array.isArray(input.camera.keyframes)
    || input.camera.keyframes.length < 2) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'profile.camera must define full_to_static_focus keyframes');
  }
  let previousAt = -1;
  const keyframes = input.camera.keyframes.map((keyframe, index) => {
    requireRecord(keyframe, `profile.camera.keyframes[${index}]`);
    rejectUnknownKeys(keyframe, KEYFRAME_KEYS, `profile.camera.keyframes[${index}]`);
    for (const key of ['atSeconds', 'zoom', 'centerX', 'centerY']) {
      if (!Number.isFinite(keyframe[key])) {
        throw new ContractError('INVALID_PRESENTATION_PROFILE', `profile.camera.keyframes[${index}].${key} must be finite`);
      }
    }
    if (keyframe.atSeconds < 0 || keyframe.atSeconds > input.durationSeconds
      || keyframe.atSeconds <= previousAt || keyframe.zoom < 1 || keyframe.zoom > 1.1
      || keyframe.centerX < 0 || keyframe.centerX > 1
      || keyframe.centerY < 0 || keyframe.centerY > 1) {
      throw new ContractError('INVALID_PRESENTATION_PROFILE', `profile.camera.keyframes[${index}] is outside the reviewed bounds`);
    }
    previousAt = keyframe.atSeconds;
    return Object.freeze({ ...keyframe });
  });
  const first = keyframes[0];
  const last = keyframes.at(-1);
  if (first.atSeconds !== 0 || first.zoom !== 1 || last.atSeconds !== 5 || last.zoom !== 1.1) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'profile camera must begin full and end at static 1.10 focus');
  }

  requireRecord(input.output, 'profile.output');
  rejectUnknownKeys(input.output, OUTPUT_KEYS, 'profile.output');
  if (input.output.codec !== 'h264' || input.output.encoder !== 'libx264'
    || input.output.pixelFormat !== 'yuv420p' || input.output.audio !== 'none'
    || input.output.preset !== 'medium' || input.output.crf !== 18) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'profile.output does not match the reviewed encoding contract');
  }

  return Object.freeze({
    ...input,
    routeIds,
    stockIds,
    camera: Object.freeze({ strategy: input.camera.strategy, keyframes: Object.freeze(keyframes) }),
    interactions: Object.freeze([]),
    output: Object.freeze({ ...input.output }),
  });
}

function validateProfilesFile(input) {
  requireRecord(input, 'presentation profiles');
  rejectUnknownKeys(input, new Set(['schemaVersion', 'profiles']), 'presentation profiles');
  if (input.schemaVersion !== 1 || !Array.isArray(input.profiles) || input.profiles.length !== 1) {
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'presentation profiles must contain the one reviewed v1 profile');
  }
  return Object.freeze({ schemaVersion: 1, profiles: Object.freeze(input.profiles.map(validateProfile)) });
}

function readProfiles(filePath = PROFILES_PATH, fsImpl = fs) {
  let value;
  try {
    value = parseJsonStrict(fsImpl.readFileSync(filePath, 'utf8'), 'presentation profiles', 'INVALID_PRESENTATION_PROFILE');
  } catch (error) {
    if (error instanceof ContractError) throw error;
    throw new ContractError('INVALID_PRESENTATION_PROFILE', 'presentation profiles could not be read');
  }
  return validateProfilesFile(value);
}

function getProfile(profiles, profileId) {
  const validated = validateProfilesFile(profiles);
  const profile = validated.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) throw new ContractError('UNSUPPORTED_PRESENTATION_PROFILE', `unsupported presentation profile: ${profileId}`);
  return profile;
}

function profileCapability(profile) {
  return Object.freeze({
    id: profile.id,
    version: profile.version,
    status: profile.status,
    sourceKind: profile.sourceKind,
    routeIds: Object.freeze([...profile.routeIds]),
    stockIds: Object.freeze([...profile.stockIds]),
    artifactRole: 'prepared-video',
  });
}

function validateProfileCapability(input) {
  requireRecord(input, 'profile capability');
  rejectUnknownKeys(input, PROFILE_CAPABILITY_KEYS, 'profile capability');
  if (input.id !== PROFILE_ID || input.version !== 1 || input.status !== 'ready_to_place'
    || input.sourceKind !== 'screenshot' || input.artifactRole !== 'prepared-video') {
    throw new ContractError(
      'INVALID_PRESENTATION_PROFILE',
      'profile capability identity or status is unsupported',
    );
  }
  return Object.freeze({
    id: input.id,
    version: input.version,
    status: input.status,
    sourceKind: input.sourceKind,
    routeIds: requireExactStrings(
      input.routeIds,
      ['chipk.stock.main-force'],
      'profile capability.routeIds',
    ),
    stockIds: requireExactStrings(input.stockIds, ['3441'], 'profile capability.stockIds'),
    artifactRole: input.artifactRole,
  });
}

module.exports = {
  PROFILE_ID,
  PROFILES_PATH,
  getProfile,
  profileCapability,
  readProfiles,
  validateProfileCapability,
  validateProfile,
  validateProfilesFile,
};
