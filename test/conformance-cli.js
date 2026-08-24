#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
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

function writeSyntheticPortraitPng(output) {
  execFileSync('ffmpeg', [
    '-v', 'error',
    '-nostdin',
    '-f', 'lavfi',
    '-i', 'color=c=0x0B1220:s=1206x2622:r=1',
    '-frames:v', '1',
    '-c:v', 'png',
    '-pix_fmt', 'rgb24',
    '-update', '1',
    '-n',
    output,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function captureRoute(catalog, input) {
  if (input.route !== 'chipk.stock.main-force') {
    fs.writeFileSync(input.output, SYNTHETIC_PNG, { flag: 'wx' });
    fs.writeFileSync(input.manifest, `${JSON.stringify({
      schemaVersion: 1,
      fixture: 'synthetic-conformance',
    })}\n`, { flag: 'wx' });
    return { verification: { contentTexts: { missing: [] } } };
  }
  if (input.requireContentTexts !== true) {
    const error = new Error('v2 conformance requires the provider-internal content gate');
    error.code = 'CONFORMANCE_CONTENT_GATE_REQUIRED';
    throw error;
  }
  writeSyntheticPortraitPng(input.output);
  const screenshot = fs.readFileSync(input.output);
  fs.writeFileSync(input.manifest, `${JSON.stringify({
    schemaVersion: 1,
    capturedAt: '2026-08-21T00:00:00.000Z',
    route: { id: input.route },
    parameters: { stockid: input.stockId, stockname: input.stockName },
    screenshot: {
      file: path.basename(input.output),
      sha256: crypto.createHash('sha256').update(screenshot).digest('hex'),
    },
    verification: {
      expectedTexts: ['主力', '主力買賣超', '3441'],
      matchedTexts: ['主力', '主力買賣超', '3441'],
      contentTexts: {
        expected: ['買賣家數差', '聯一光'],
        observed: ['買賣家數差', '聯一光'],
        missing: [],
      },
    },
    catalogVersion: catalog.catalogVersion,
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
  preparedRendererOptions: {
    clock: () => Date.parse('2026-08-21T00:00:01.000Z'),
  },
  now: () => new Date('2026-08-21T00:00:00.000Z'),
});

main(process.argv.slice(2), undefined, { runtimeAdapter }).then((code) => {
  process.exitCode = code;
});
