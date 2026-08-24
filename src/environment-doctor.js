'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseJsonStrict } = require('./strict-json');

const PROFILE_KEYS = new Set(['schemaVersion', 'provider', 'xcode', 'simulator']);
const PROVIDER_KEYS = new Set(['executable', 'expectedId', 'expectedVersion', 'expectedCommit', 'installationKind']);
const XCODE_KEYS = new Set(['developerDir']);
const SIMULATOR_KEYS = new Set(['udid', 'role']);
const FORBIDDEN_RUN_KEYS = new Set([
  'CHIPK_CAPTURE_AUTHORIZED',
  'CHIPK_DEDICATED_SIMULATOR_CONFIRMED',
  'CHIPK_VIP_SESSION_CONFIRMED',
]);
const UDID_RE = /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/i;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const PINNED_PROVIDER = Object.freeze({
  id: 'chipk-simulator-capture',
  version: '0.3.0',
  commit: '586fbe7414ab0c25d78ae6e462887fe72030e0a7',
});
const RUN_CONTRACT = Object.freeze({
  authorization: 'human_required_per_run',
  dedicatedDevice: 'automatic_pre_run_doctor',
  vipSession: 'automatic_provider_runtime_verification',
});

class DoctorError extends Error {
  constructor(code, message, action) {
    super(message);
    this.code = code;
    this.action = action;
  }
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new DoctorError('MACHINE_PROFILE_INVALID', `${label} must be an object`, 'Repair the machine profile.');
  }
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      const code = FORBIDDEN_RUN_KEYS.has(key) ? 'RUN_AUTHORIZATION_MUST_NOT_BE_PERSISTED' : 'MACHINE_PROFILE_INVALID';
      throw new DoctorError(code, `${label}.${key} is not allowed`, 'Remove run-only attestations from the machine profile.');
    }
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DoctorError('MACHINE_PROFILE_INVALID', `${label} must be a non-empty string`, 'Repair the machine profile.');
  }
  return value;
}

function validateProfile(input) {
  exactKeys(input, PROFILE_KEYS, 'profile');
  exactKeys(input.provider, PROVIDER_KEYS, 'profile.provider');
  exactKeys(input.xcode, XCODE_KEYS, 'profile.xcode');
  exactKeys(input.simulator, SIMULATOR_KEYS, 'profile.simulator');
  if (input.schemaVersion !== 1) throw new DoctorError('MACHINE_PROFILE_INVALID', 'schemaVersion must be 1', 'Regenerate the machine profile.');
  const profile = {
    schemaVersion: 1,
    provider: {
      executable: requiredString(input.provider.executable, 'profile.provider.executable'),
      expectedId: requiredString(input.provider.expectedId, 'profile.provider.expectedId'),
      expectedVersion: requiredString(input.provider.expectedVersion, 'profile.provider.expectedVersion'),
      expectedCommit: requiredString(input.provider.expectedCommit, 'profile.provider.expectedCommit').toLowerCase(),
      installationKind: requiredString(input.provider.installationKind, 'profile.provider.installationKind'),
    },
    xcode: { developerDir: requiredString(input.xcode.developerDir, 'profile.xcode.developerDir') },
    simulator: {
      udid: requiredString(input.simulator.udid, 'profile.simulator.udid').toUpperCase(),
      role: requiredString(input.simulator.role, 'profile.simulator.role'),
    },
  };
  if (!path.isAbsolute(profile.provider.executable) || !path.isAbsolute(profile.xcode.developerDir)) {
    throw new DoctorError('MACHINE_PROFILE_INVALID', 'provider executable and developerDir must be absolute', 'Use verified absolute paths.');
  }
  if (!COMMIT_RE.test(profile.provider.expectedCommit) || !UDID_RE.test(profile.simulator.udid)) {
    throw new DoctorError('MACHINE_PROFILE_INVALID', 'expectedCommit or simulator UDID has an invalid shape', 'Repair the machine profile.');
  }
  if (profile.provider.expectedId !== PINNED_PROVIDER.id ||
      profile.provider.expectedVersion !== PINNED_PROVIDER.version ||
      profile.provider.expectedCommit !== PINNED_PROVIDER.commit) {
    throw new DoctorError('PROVIDER_LOCK_INVALID', 'machine profile must use the reviewed v0.3.0 provider lock', 'Regenerate the profile from the reviewed compatibility lock.');
  }
  if (profile.provider.installationKind !== 'immutable-release-clone') {
    throw new DoctorError('PROVIDER_INSTALLATION_UNSTABLE', 'provider must be an immutable standalone release clone', 'Install the pinned release in a standalone runtime directory.');
  }
  if (profile.simulator.role !== 'dedicated-test-simulator') {
    throw new DoctorError('SIMULATOR_NOT_DEDICATED', 'configured Simulator is not assigned the dedicated test role', 'Have a human assign and record one exact dedicated test Simulator.');
  }
  return profile;
}

function readProfile(filePath, fsApi = fs) {
  let metadata;
  try { metadata = fsApi.lstatSync(filePath); } catch {
    throw new DoctorError('MACHINE_PROFILE_MISSING', `machine profile is unavailable: ${filePath}`, 'Run the configure command after verifying the machine identity.');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
    throw new DoctorError('MACHINE_PROFILE_INVALID', 'machine profile must be a small regular non-symlink file', 'Replace it with a safe local profile.');
  }
  try {
    return validateProfile(parseJsonStrict(fsApi.readFileSync(filePath, 'utf8'), 'machine profile', 'MACHINE_PROFILE_INVALID'));
  } catch (error) {
    if (error instanceof DoctorError) throw error;
    throw new DoctorError('MACHINE_PROFILE_INVALID', 'machine profile is not valid strict JSON', 'Regenerate the local machine profile.');
  }
}

function run(command, args, options, exec = spawnSync) {
  const result = exec(command, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    return { ok: false, stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
  }
  return { ok: true, stdout: result.stdout || '', stderr: result.stderr || '', status: result.status };
}

function parseOutput(value, code, action) {
  try { return JSON.parse(value); } catch { throw new DoctorError(code, 'command returned invalid JSON', action); }
}

function standaloneReleaseRoot(executable, exec) {
  const root = path.resolve(path.dirname(executable), '..');
  const head = run('git', ['-C', root, 'rev-parse', 'HEAD'], {}, exec);
  const common = run('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {}, exec);
  if (!head.ok || !common.ok) throw new DoctorError('PROVIDER_IDENTITY_UNVERIFIABLE', 'provider is not a verifiable Git release clone', 'Install the pinned annotated release in a standalone directory.');
  const commonDir = path.resolve(common.stdout.trim());
  if (commonDir !== path.join(root, '.git')) {
    throw new DoctorError('PROVIDER_INSTALLATION_UNSTABLE', 'provider executable belongs to a linked worktree', 'Use an independent immutable release clone, not a workspace worktree.');
  }
  return { root, commit: head.stdout.trim().toLowerCase() };
}

function doctor(profile, options = {}) {
  const exec = options.exec || spawnSync;
  const checks = [];
  const fail = (error) => ({
    schemaVersion: 1,
    status: 'HUMAN_ACTION_REQUIRED',
    sideEffectFree: true,
    checks,
    error: { code: error.code || 'ENVIRONMENT_DOCTOR_FAILED', message: error.message, action: error.action || 'Inspect the environment.' },
    runContract: RUN_CONTRACT,
  });
  try {
    checks.push({ id: 'machine_profile', status: 'passed' });
    let executableMetadata;
    try { executableMetadata = fs.lstatSync(profile.provider.executable); } catch {
      throw new DoctorError('PROVIDER_EXECUTABLE_MISSING', 'configured provider executable is unavailable', 'Install the pinned provider release and update the profile.');
    }
    if (!executableMetadata.isFile() || executableMetadata.isSymbolicLink()) {
      throw new DoctorError('PROVIDER_EXECUTABLE_INVALID', 'provider executable must be a regular non-symlink file', 'Repair the pinned provider installation.');
    }
    const installation = standaloneReleaseRoot(profile.provider.executable, exec);
    if (installation.commit !== profile.provider.expectedCommit) {
      throw new DoctorError('PROVIDER_COMMIT_MISMATCH', `provider commit is ${installation.commit}`, `Install commit ${profile.provider.expectedCommit}.`);
    }
    const childEnv = { ...process.env };
    delete childEnv.CHIPK_CAPTURE_AUTHORIZED;
    delete childEnv.CHIPK_DEDICATED_SIMULATOR_CONFIRMED;
    delete childEnv.CHIPK_VIP_SESSION_CONFIRMED;
    delete childEnv.CHIPK_SIMULATOR_UDID;
    const capabilityRun = run(profile.provider.executable, ['capabilities', '--json'], { env: childEnv }, exec);
    if (!capabilityRun.ok) throw new DoctorError('PROVIDER_PROBE_FAILED', 'provider capabilities probe failed', 'Repair the pinned provider runtime.');
    const capabilities = parseOutput(capabilityRun.stdout, 'PROVIDER_PROBE_INVALID', 'Repair the pinned provider runtime.');
    if (capabilities.providerId !== profile.provider.expectedId || capabilities.toolVersion !== profile.provider.expectedVersion) {
      throw new DoctorError('PROVIDER_IDENTITY_MISMATCH', `provider reported ${capabilities.providerId}@${capabilities.toolVersion}`, `Install ${profile.provider.expectedId}@${profile.provider.expectedVersion}.`);
    }
    checks.push({ id: 'provider_identity', status: 'passed', version: capabilities.toolVersion, commit: installation.commit });

    let developerDirectory;
    try { developerDirectory = fs.statSync(profile.xcode.developerDir); } catch {
      throw new DoctorError('XCODE_DEVELOPER_DIR_MISSING', 'configured Xcode developer directory is unavailable', 'Install Xcode or update the local machine profile.');
    }
    if (!developerDirectory.isDirectory()) throw new DoctorError('XCODE_DEVELOPER_DIR_MISSING', 'configured Xcode developer directory is unavailable', 'Install Xcode or update the local machine profile.');
    const xcodeEnv = { ...process.env, DEVELOPER_DIR: profile.xcode.developerDir };
    const findSimctl = run('/usr/bin/xcrun', ['--find', 'simctl'], { env: xcodeEnv }, exec);
    if (!findSimctl.ok || !path.isAbsolute(findSimctl.stdout.trim())) throw new DoctorError('SIMCTL_UNAVAILABLE', 'simctl is unavailable under the configured developer directory', 'Select a valid full Xcode path in the machine profile.');
    checks.push({ id: 'xcode_simctl', status: 'passed', developerDir: profile.xcode.developerDir, simctl: findSimctl.stdout.trim() });

    const list = run('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'available', '--json'], { env: xcodeEnv }, exec);
    if (!list.ok) throw new DoctorError('SIMULATOR_LIST_UNAVAILABLE', 'available Simulator devices could not be listed', 'Open Xcode once and repair Simulator runtimes.');
    const payload = parseOutput(list.stdout, 'SIMULATOR_LIST_INVALID', 'Repair the local Simulator runtime.');
    const matches = Object.entries(payload.devices || {}).flatMap(([runtime, devices]) =>
      (Array.isArray(devices) ? devices : []).filter((device) => String(device.udid).toUpperCase() === profile.simulator.udid).map((device) => ({ ...device, runtime })),
    );
    if (matches.length === 0) throw new DoctorError('SIMULATOR_NOT_FOUND', `configured Simulator ${profile.simulator.udid} is not available`, 'Update the profile only after verifying the replacement dedicated device.');
    if (matches.length > 1) throw new DoctorError('SIMULATOR_IDENTITY_AMBIGUOUS', `configured UDID matched ${matches.length} available devices`, 'Repair duplicate or stale Simulator runtime records.');
    if (matches[0].state !== 'Booted') throw new DoctorError('SIMULATOR_NOT_BOOTED', `configured Simulator is ${matches[0].state}`, 'Boot the exact dedicated Simulator, then rerun doctor.');
    checks.push({ id: 'dedicated_simulator_identity', status: 'passed', udid: profile.simulator.udid, name: matches[0].name, runtime: matches[0].runtime, state: matches[0].state });
    return {
      schemaVersion: 1,
      status: 'READY',
      scope: 'simulator_environment_only',
      sideEffectFree: true,
      checks,
      runContract: RUN_CONTRACT,
    };
  } catch (error) { return fail(error); }
}

module.exports = { DoctorError, PINNED_PROVIDER, RUN_CONTRACT, doctor, readProfile, validateProfile };
