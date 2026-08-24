'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DoctorError, PINNED_PROVIDER, RUN_CONTRACT, doctor, readProfile, validateProfile } = require('./environment-doctor');

const DEFAULT_PROFILE = path.resolve(__dirname, '..', '.runtime', 'machine-profile.json');

function writeJson(stream, value) { stream.write(`${JSON.stringify(value, null, 2)}\n`); }

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['doctor', 'configure', 'acquire'].includes(command)) throw new Error('command must be doctor, configure, or acquire');
  const values = {};
  const booleanFlags = new Set(['--json', '--authorize-run', '--confirm-dedicated-machine-role']);
  const valueFlags = new Set(['--profile', '--provider-bin', '--developer-dir', '--udid', '--request']);
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (booleanFlags.has(flag)) { values[flag] = true; continue; }
    if (!valueFlags.has(flag) || !rest[index + 1] || rest[index + 1].startsWith('--')) throw new Error(`invalid argument: ${flag}`);
    values[flag] = rest[index + 1];
    index += 1;
  }
  if (['doctor', 'acquire'].includes(command) && !values['--json']) throw new Error('--json is required');
  if (command === 'acquire' && (!values['--request'] || !path.isAbsolute(values['--request']))) throw new Error('acquire requires an absolute --request path');
  if (command === 'configure' && !values['--confirm-dedicated-machine-role']) throw new Error('configure requires --confirm-dedicated-machine-role');
  return { command, profilePath: path.resolve(values['--profile'] || DEFAULT_PROFILE), values };
}

function configure(profilePath, values, fsApi = fs) {
  if (fsApi.existsSync(profilePath)) throw new Error(`refusing to overwrite existing profile: ${profilePath}`);
  if (!values['--confirm-dedicated-machine-role']) throw new Error('refusing to assign a Booted device without explicit dedicated machine-role confirmation');
  const profile = validateProfile({
    schemaVersion: 1,
    provider: {
      executable: values['--provider-bin'], expectedId: PINNED_PROVIDER.id, expectedVersion: PINNED_PROVIDER.version,
      expectedCommit: PINNED_PROVIDER.commit, installationKind: 'immutable-release-clone',
    },
    xcode: { developerDir: values['--developer-dir'] },
    simulator: { udid: values['--udid'], role: 'dedicated-test-simulator' },
  });
  fsApi.mkdirSync(path.dirname(profilePath), { recursive: true });
  const temporary = `${profilePath}.tmp-${process.pid}`;
  fsApi.writeFileSync(temporary, `${JSON.stringify(profile, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    fsApi.linkSync(temporary, profilePath);
    fsApi.unlinkSync(temporary);
  } catch (error) {
    try { fsApi.unlinkSync(temporary); } catch {}
    throw error;
  }
  return profile;
}

function main(argv, streams = { stdout: process.stdout, stderr: process.stderr }, options = {}) {
  try {
    const args = parseArgs(argv);
    if (args.command === 'configure') {
      configure(args.profilePath, args.values, options.fs);
      writeJson(streams.stdout, { status: 'CONFIGURED', profile: args.profilePath, persistedRunAuthorization: false });
      return 0;
    }
    let result;
    try {
      result = doctor(readProfile(args.profilePath, options.fs), options);
    } catch (error) {
      if (!(error instanceof DoctorError)) throw error;
      result = {
        schemaVersion: 1,
        status: 'HUMAN_ACTION_REQUIRED',
        sideEffectFree: true,
        checks: [],
        error: { code: error.code, message: error.message, action: error.action },
        runContract: RUN_CONTRACT,
      };
    }
    if (result.status !== 'READY' || args.command === 'doctor') {
      writeJson(streams.stdout, result);
      return result.status === 'READY' ? 0 : 3;
    }
    if (!args.values['--authorize-run']) {
      writeJson(streams.stdout, {
        schemaVersion: 1,
        status: 'HUMAN_ACTION_REQUIRED',
        sideEffectFree: true,
        checks: result.checks,
        error: { code: 'RUN_AUTHORIZATION_REQUIRED', message: '--authorize-run is required for this acquisition', action: 'Obtain explicit approval for this exact acquisition.' },
        runContract: result.runContract,
      });
      return 3;
    }
    const profile = readProfile(args.profilePath, options.fs);
    const child = (options.exec || spawnSync)(profile.provider.executable, ['acquire', '--request', args.values['--request'], '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        DEVELOPER_DIR: profile.xcode.developerDir,
        CHIPK_SIMULATOR_UDID: profile.simulator.udid,
        CHIPK_CAPTURE_AUTHORIZED: '1',
        // v0.3.0 legacy adapter gates. The launcher derives dedicated identity from doctor and
        // delegates session truth to the Provider's fail-closed target/login/content assertions.
        CHIPK_DEDICATED_SIMULATOR_CONFIRMED: '1',
        CHIPK_VIP_SESSION_CONFIRMED: '1',
      },
    });
    if (child.stdout) streams.stdout.write(child.stdout);
    if (child.stderr) streams.stderr.write(child.stderr);
    return child.status === null || child.status === undefined ? 2 : child.status;
  } catch (error) {
    writeJson(streams.stderr, { error: { code: error.code || 'INVALID_MACHINE_COMMAND', message: error.message } });
    return 2;
  }
}

module.exports = { DEFAULT_PROFILE, configure, main, parseArgs };
