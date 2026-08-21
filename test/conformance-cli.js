#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const { main } = require('../src/cli');
const { createRuntimeAdapter } = require('../src/runtime-adapter');

const SYNTHETIC_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=',
  'base64',
);

const environment = Object.freeze({
  CHIPK_SIMULATOR_UDID: '11111111-1111-1111-1111-111111111111',
  CHIPK_CAPTURE_AUTHORIZED: '1',
  CHIPK_DEDICATED_SIMULATOR_CONFIRMED: '1',
  CHIPK_VIP_SESSION_CONFIRMED: '1',
});

async function captureRoute(_catalog, input) {
  fs.writeFileSync(input.output, SYNTHETIC_PNG, { flag: 'wx' });
  fs.writeFileSync(input.manifest, `${JSON.stringify({
    schemaVersion: 1,
    fixture: 'synthetic-conformance',
  })}\n`, { flag: 'wx' });
  return { verification: { contentTexts: { missing: [] } } };
}

async function recordRecipe() {
  const error = new Error('The conformance driver supports screenshot requests only.');
  error.code = 'CONFORMANCE_SCREENSHOT_ONLY';
  throw error;
}

const runtimeAdapter = createRuntimeAdapter({
  environment,
  captureRoute,
  recordRecipe,
  now: () => new Date('2026-08-21T00:00:00.000Z'),
});

main(process.argv.slice(2), undefined, { runtimeAdapter }).then((code) => {
  process.exitCode = code;
});
