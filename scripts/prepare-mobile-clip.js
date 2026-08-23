#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseJsonStrict } = require('../src/strict-json');
const {
  PreparationError,
  buildPreparedPlan,
  getProfile,
  validateProfilesFile,
} = require('../src/prepared-plan');
const { probeVideo, renderPrepared } = require('../src/prepared-renderer');
const { readCatalog } = require('./simulator-capture');

const PROFILES_PATH = path.resolve(__dirname, '../config/presentation-profiles.experimental.json');

function readJson(filePath, label) {
  try {
    return parseJsonStrict(fs.readFileSync(path.resolve(filePath), 'utf8'), label, 'invalid_preparation_input');
  } catch (error) {
    if (error instanceof PreparationError) throw error;
    throw new PreparationError('invalid_preparation_input', `${label} 無法讀取`);
  }
}

function readProfiles() {
  return validateProfilesFile(readJson(PROFILES_PATH, 'presentation profiles'));
}

function parseArgs(argv) {
  const command = argv[0];
  const values = Object.create(null);
  const booleans = new Set(['json']);
  const allowed = {
    'profile-check': new Set(['json']),
    plan: new Set(['raw', 'actions', 'profile', 'json']),
    render: new Set([
      'raw', 'actions', 'recording-manifest', 'profile', 'video', 'plan', 'manifest', 'json',
    ]),
  };
  for (let index = 1; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) throw new PreparationError('unknown_argument', `無法識別的參數：${item}`);
    const equalAt = item.indexOf('=');
    const key = item.slice(2, equalAt >= 0 ? equalAt : undefined);
    if (!allowed[command]?.has(key)) throw new PreparationError('unknown_flag', `${command} 不允許 --${key}`);
    if (values[key] !== undefined) throw new PreparationError('duplicate_argument', `--${key} 不得重複`);
    if (booleans.has(key)) {
      if (equalAt >= 0) throw new PreparationError('invalid_boolean_flag', `--${key} 不接受值`);
      values[key] = true;
      continue;
    }
    const value = equalAt >= 0 ? item.slice(equalAt + 1) : argv[++index];
    if (value === undefined || value.startsWith('--')) {
      throw new PreparationError('missing_value', `--${key} 缺少值`);
    }
    values[key] = value;
  }
  return { command, values };
}

function required(values, keys) {
  for (const key of keys) {
    if (!values[key]) throw new PreparationError('missing_argument', `--${key} 為必要參數`);
  }
}

function usage() {
  return [
    '用法：',
    '  node scripts/prepare-mobile-clip.js profile-check [--json]',
    '  node scripts/prepare-mobile-clip.js plan --raw <raw.mp4> --actions <actions.json> --profile <id> [--json]',
    '  node scripts/prepare-mobile-clip.js render --raw <raw.mp4> --actions <actions.json> --recording-manifest <recording-manifest.json> --profile <id> --video <new.mp4> --plan <new.json> --manifest <new.json> [--json]',
  ].join('\n');
}

async function main(argv = process.argv.slice(2)) {
  const { command, values } = parseArgs(argv);
  if (!command || ['help', '--help', '-h'].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const profiles = readProfiles();
  if (command === 'profile-check') {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      status: profiles.status,
      profileIds: profiles.profiles.map((profile) => profile.id),
      profiles: 'config/presentation-profiles.experimental.json',
    }, null, 2)}\n`);
    return;
  }
  if (command === 'plan') {
    required(values, ['raw', 'actions', 'profile']);
    const profile = getProfile(profiles, values.profile);
    const actions = readJson(values.actions, 'actions');
    const plan = buildPreparedPlan(
      actions,
      profile,
      probeVideo(path.resolve(values.raw)),
      readCatalog(),
    );
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }
  if (command === 'render') {
    required(values, ['raw', 'actions', 'recording-manifest', 'profile', 'video', 'plan', 'manifest']);
    const profile = getProfile(profiles, values.profile);
    const result = await renderPrepared({
      raw: values.raw,
      actions: values.actions,
      recordingManifest: values['recording-manifest'],
      profile,
      catalog: readCatalog(),
      video: values.video,
      plan: values.plan,
      manifest: values.manifest,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  throw new PreparationError('unknown_command', `未知 command：${command}\n${usage()}`);
}

if (require.main === module) {
  main().catch((error) => {
    const payload = {
      ok: false,
      error: error.code || 'unexpected_error',
      message: error.message,
    };
    if (error.details) payload.details = error.details;
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { PROFILES_PATH, main, parseArgs, readProfiles };
