'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const DOCUMENTS = [
  'README.md',
  'docs/source-coverage.md',
  'docs/release-v0.2.1-checklist.md',
];

function npmJson(script) {
  return spawnSync('npm', ['run', '--silent', script], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('documented JSON-consuming npm entrypoints always use --silent', () => {
  const content = DOCUMENTS.map((file) => fs.readFileSync(path.join(ROOT, file), 'utf8')).join('\n');
  assert.doesNotMatch(content, /npm run (?:coverage:source|release:gate:v0\.2\.1)/);
  assert.match(content, /npm run --silent coverage:source/);
  assert.match(content, /npm run --silent release:gate:v0\.2\.1/);

  const checklist = fs.readFileSync(
    path.join(ROOT, 'docs', 'release-v0.2.1-checklist.md'),
    'utf8',
  );
  const evidenceCommand = [
    'npm run --silent release:gate:v0.2.1 -- \\',
    '  --evidence "$PWD/.runtime/release-v0.2.1-evidence.json"',
  ].join('\n');
  assert.equal(checklist.includes(evidenceCommand), true);
});

test('silent coverage entrypoint writes one parseable JSON document to stdout', () => {
  const result = npmJson('coverage:source');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).reportType, 'provider_source_coverage');
});

test('silent release checklist keeps its blocked exit while stdout remains parseable JSON', () => {
  const result = npmJson('release:gate:v0.2.1');
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.checklistStatus, 'incomplete');
  assert.equal(output.releaseDecision, 'human_required');
});
