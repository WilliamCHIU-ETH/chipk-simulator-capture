'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { doctor, validateProfile } = require('../src/environment-doctor');
const { configure, main } = require('../src/environment-doctor-cli');

const COMMIT = '586fbe7414ab0c25d78ae6e462887fe72030e0a7';
const UDID = '9B49B7D4-AB50-4829-9D78-45F419EDA998';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chipk-doctor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const providerRoot = path.join(root, 'provider');
  const executable = path.join(providerRoot, 'bin', 'chipk-capture.js');
  const developerDir = path.join(root, 'Custom Xcode.app', 'Contents', 'Developer');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.mkdirSync(path.join(providerRoot, '.git'));
  fs.mkdirSync(developerDir, { recursive: true });
  fs.writeFileSync(executable, '#!/usr/bin/env node\n');
  const profile = validateProfile({
    schemaVersion: 1,
    provider: {
      executable, expectedId: 'chipk-simulator-capture', expectedVersion: '0.3.0',
      expectedCommit: COMMIT, installationKind: 'immutable-release-clone',
    },
    xcode: { developerDir },
    simulator: { udid: UDID, role: 'dedicated-test-simulator' },
  });
  return { root, providerRoot, executable, developerDir, profile };
}

function fakeExec(f, overrides = {}) {
  return (command, args, options) => {
    const key = `${command} ${args.join(' ')}`;
    if (overrides[key]) return overrides[key](options);
    if (command === 'git' && args.at(-1) === 'HEAD') return { status: 0, stdout: `${COMMIT}\n`, stderr: '' };
    if (command === 'git' && args.at(-1) === '--git-common-dir') return { status: 0, stdout: `${path.join(f.providerRoot, '.git')}\n`, stderr: '' };
    if (command === f.executable) {
      assert.equal(options.env.CHIPK_CAPTURE_AUTHORIZED, undefined);
      assert.equal(options.env.CHIPK_DEDICATED_SIMULATOR_CONFIRMED, undefined);
      assert.equal(options.env.CHIPK_VIP_SESSION_CONFIRMED, undefined);
      return { status: 0, stdout: JSON.stringify({ providerId: 'chipk-simulator-capture', toolVersion: '0.3.0' }), stderr: '' };
    }
    if (command === '/usr/bin/xcrun' && args[0] === '--find') {
      assert.equal(options.env.DEVELOPER_DIR, f.developerDir);
      return { status: 0, stdout: `${path.join(f.developerDir, 'usr', 'bin', 'simctl')}\n`, stderr: '' };
    }
    if (command === '/usr/bin/xcrun' && args[0] === 'simctl') {
      assert.equal(options.env.DEVELOPER_DIR, f.developerDir);
      return { status: 0, stdout: JSON.stringify({ devices: { 'runtime-custom': [{ udid: UDID, name: 'iPhone 17 Pro', state: 'Booted' }] } }), stderr: '' };
    }
    throw new Error(`unexpected command: ${key}`);
  };
}

test('READY uses configured full/custom Xcode even when the global selection may be CommandLineTools', (t) => {
  const f = fixture(t);
  const result = doctor(f.profile, { exec: fakeExec(f) });
  assert.equal(result.status, 'READY');
  assert.equal(result.scope, 'simulator_environment_only');
  assert.equal(result.sideEffectFree, true);
  assert.equal(result.runContract.authorization, 'human_required_per_run');
  assert.equal(result.runContract.dedicatedDevice, 'automatic_pre_run_doctor');
  assert.equal(result.runContract.vipSession, 'automatic_provider_runtime_verification');
  assert.equal(result.checks[1].version, '0.3.0');
  assert.equal(result.checks[2].developerDir, f.developerDir);
  assert.equal(result.checks[3].udid, UDID);
});

test('simctl missing is a typed blocker', (t) => {
  const f = fixture(t);
  const key = '/usr/bin/xcrun --find simctl';
  const result = doctor(f.profile, { exec: fakeExec(f, { [key]: () => ({ status: 1, stdout: '', stderr: 'missing' }) }) });
  assert.equal(result.status, 'HUMAN_ACTION_REQUIRED');
  assert.equal(result.error.code, 'SIMCTL_UNAVAILABLE');
});

test('wrong provider version and stale commit fail before Simulator inspection', (t) => {
  const f = fixture(t);
  const head = `git -C ${f.providerRoot} rev-parse HEAD`;
  let result = doctor(f.profile, { exec: fakeExec(f, { [head]: () => ({ status: 0, stdout: `${'a'.repeat(40)}\n`, stderr: '' }) }) });
  assert.equal(result.error.code, 'PROVIDER_COMMIT_MISMATCH');
  const probe = `${f.executable} capabilities --json`;
  result = doctor(f.profile, { exec: fakeExec(f, { [probe]: () => ({ status: 0, stdout: JSON.stringify({ providerId: 'chipk-simulator-capture', toolVersion: '0.2.1' }), stderr: '' }) }) });
  assert.equal(result.error.code, 'PROVIDER_IDENTITY_MISMATCH');
});

test('linked worktree is rejected as a long-term provider installation', (t) => {
  const f = fixture(t);
  const key = 'git -C ' + f.providerRoot + ' rev-parse --path-format=absolute --git-common-dir';
  const result = doctor(f.profile, { exec: fakeExec(f, { [key]: () => ({ status: 0, stdout: '/shared/repository/.git\n', stderr: '' }) }) });
  assert.equal(result.error.code, 'PROVIDER_INSTALLATION_UNSTABLE');
});

test('missing, duplicate, and non-booted exact UDID return distinct blockers', (t) => {
  const f = fixture(t);
  const key = '/usr/bin/xcrun simctl list devices available --json';
  const list = (devices) => () => ({ status: 0, stdout: JSON.stringify({ devices }), stderr: '' });
  let result = doctor(f.profile, { exec: fakeExec(f, { [key]: list({ runtime: [] }) }) });
  assert.equal(result.error.code, 'SIMULATOR_NOT_FOUND');
  result = doctor(f.profile, { exec: fakeExec(f, { [key]: list({ a: [{ udid: UDID, state: 'Booted' }], b: [{ udid: UDID, state: 'Booted' }] }) }) });
  assert.equal(result.error.code, 'SIMULATOR_IDENTITY_AMBIGUOUS');
  result = doctor(f.profile, { exec: fakeExec(f, { [key]: list({ a: [{ udid: UDID, state: 'Shutdown' }] }) }) });
  assert.equal(result.error.code, 'SIMULATOR_NOT_BOOTED');
});

test('machine profile cannot persist per-run authorization or attestations', () => {
  const base = {
    schemaVersion: 1,
    provider: { executable: '/provider/bin/chipk-capture.js', expectedId: 'chipk-simulator-capture', expectedVersion: '0.3.0', expectedCommit: COMMIT, installationKind: 'immutable-release-clone' },
    xcode: { developerDir: '/Applications/Xcode.app/Contents/Developer' },
    simulator: { udid: UDID, role: 'dedicated-test-simulator' },
  };
  for (const key of ['CHIPK_CAPTURE_AUTHORIZED', 'CHIPK_DEDICATED_SIMULATOR_CONFIRMED', 'CHIPK_VIP_SESSION_CONFIRMED']) {
    assert.throws(() => validateProfile({ ...base, [key]: '1' }), { code: 'RUN_AUTHORIZATION_MUST_NOT_BE_PERSISTED' });
  }
});

test('configure creates a mode-0600 profile atomically and never overwrites', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'local', 'machine-profile.json');
  const values = { '--provider-bin': f.executable, '--developer-dir': f.developerDir, '--udid': UDID, '--confirm-dedicated-machine-role': true };
  configure(target, values);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const persisted = JSON.parse(fs.readFileSync(target, 'utf8'));
  assert.equal(persisted.simulator.role, 'dedicated-test-simulator');
  assert.equal('CHIPK_CAPTURE_AUTHORIZED' in persisted, false);
  assert.throws(() => configure(target, values), /refusing to overwrite/);
});

test('configure never infers dedicated identity from Booted state alone', (t) => {
  const f = fixture(t);
  const target = path.join(f.root, 'machine-profile.json');
  assert.throws(
    () => configure(target, { '--provider-bin': f.executable, '--developer-dir': f.developerDir, '--udid': UDID }),
    /dedicated machine-role confirmation/,
  );
  assert.equal(fs.existsSync(target), false);
});

test('blank-session canonical command returns a typed missing-profile blocker', () => {
  let stdout = '';
  let stderr = '';
  const profile = path.join(os.tmpdir(), `missing-chipk-profile-${process.pid}.json`);
  const code = main(['doctor', '--profile', profile, '--json'], { stdout: { write: (v) => { stdout += v; } }, stderr: { write: (v) => { stderr += v; } } });
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout).error.code, 'MACHINE_PROFILE_MISSING');
  assert.equal(stderr, '');
});

test('acquire converts authorization plus automatic checks to child-only v0.3.0 gates', (t) => {
  const f = fixture(t);
  const profilePath = path.join(f.root, 'machine-profile.json');
  fs.writeFileSync(profilePath, `${JSON.stringify(f.profile)}\n`);
  const requestPath = path.join(f.root, 'request.json');
  fs.writeFileSync(requestPath, '{}\n');
  const baseExec = fakeExec(f);
  let acquireEnvironment;
  const exec = (command, args, options) => {
    if (command === f.executable && args[0] === 'acquire') {
      acquireEnvironment = options.env;
      return {
        status: 3,
        stdout: '{"status":"human_action_required","error":{"code":"SESSION_PREFLIGHT_EVIDENCE_INCOMPLETE"}}\n',
        stderr: '',
      };
    }
    return baseExec(command, args, options);
  };
  let stdout = '';
  const code = main([
    'acquire', '--profile', profilePath, '--request', requestPath, '--authorize-run', '--json',
  ], { stdout: { write: (v) => { stdout += v; } }, stderr: { write: () => {} } }, { exec });
  assert.equal(code, 3);
  assert.equal(JSON.parse(stdout).status, 'human_action_required');
  assert.equal(JSON.parse(stdout).error.code, 'SESSION_PREFLIGHT_EVIDENCE_INCOMPLETE');
  assert.equal(acquireEnvironment.DEVELOPER_DIR, f.developerDir);
  assert.equal(acquireEnvironment.CHIPK_SIMULATOR_UDID, UDID);
  assert.equal(acquireEnvironment.CHIPK_CAPTURE_AUTHORIZED, '1');
  assert.equal(process.env.CHIPK_CAPTURE_AUTHORIZED, undefined);
});

test('deprecated dedicated and VIP human flags are rejected instead of becoming extra gates', () => {
  for (const flag of ['--confirm-dedicated', '--confirm-vip-session']) {
    let stderr = '';
    const code = main(
      ['acquire', '--request', '/absolute/request.json', '--authorize-run', flag, '--json'],
      { stdout: { write: () => {} }, stderr: { write: (v) => { stderr += v; } } },
    );
    assert.equal(code, 2);
    assert.equal(JSON.parse(stderr).error.code, 'INVALID_MACHINE_COMMAND');
  }
});

test('acquire asks only for run authorization after automatic environment validation', (t) => {
  const f = fixture(t);
  const profilePath = path.join(f.root, 'machine-profile.json');
  fs.writeFileSync(profilePath, `${JSON.stringify(f.profile)}\n`);
  const requestPath = path.join(f.root, 'request.json');
  fs.writeFileSync(requestPath, '{}\n');
  let stdout = '';
  const code = main(
    ['acquire', '--profile', profilePath, '--request', requestPath, '--json'],
    { stdout: { write: (v) => { stdout += v; } }, stderr: { write: () => {} } },
    { exec: fakeExec(f) },
  );
  const result = JSON.parse(stdout);
  assert.equal(code, 3);
  assert.equal(result.error.code, 'RUN_AUTHORIZATION_REQUIRED');
  assert.equal(result.runContract.dedicatedDevice, 'automatic_pre_run_doctor');
  assert.equal(result.runContract.vipSession, 'automatic_provider_runtime_verification');
});
