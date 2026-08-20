#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sourceContentIssues, structuredValueIssues } = require('../src/sensitive-taxonomy');
const { parseJsonStrict } = require('../src/strict-json');

const ROOT = path.resolve(__dirname, '..');
const SKIP_PATHS = new Set([
  path.join(ROOT, '.git'),
  path.join(ROOT, 'node_modules'),
  path.join(ROOT, 'runtime-data'),
]);
const FORBIDDEN_DIRECTORIES = new Set(['runtime-data', 'coverage', '.deploy']);
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.png', '.jpg', '.jpeg', '.webp', '.heic',
  '.wav', '.mp3', '.m4a', '.sqlite', '.db', '.plist', '.log',
]);
const FORBIDDEN_FILENAMES = new Set(['.env', '.npmrc']);
function filesUnder(directory, errors) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (SKIP_PATHS.has(target)) continue;
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRECTORIES.has(entry.name.toLowerCase())) {
        errors.push(`${path.relative(ROOT, target)}: generated/runtime directory is not source`);
      } else {
        result.push(...filesUnder(target, errors));
      }
    }
    else if (entry.isFile()) result.push(target);
    else throw new Error(`unsupported filesystem entry: ${path.relative(ROOT, target)}`);
  }
  return result;
}

const forbiddenContent = [
  ['runtime process module', new RegExp('node:' + 'child_process')],
];

function inspectJsonContent(content, label = 'JSON source') {
  let parsed;
  try {
    parsed = parseJsonStrict(content, label, 'INVALID_SANITIZED_JSON');
  } catch (error) {
    return [`${error.code || 'INVALID_SANITIZED_JSON'}: JSON failed strict validation`];
  }
  return structuredValueIssues(parsed, label);
}

function scanTree() {
  const errors = [];
  for (const file of filesUnder(ROOT, errors)) {
    const relative = path.relative(ROOT, file);
    const extension = path.extname(file).toLowerCase();
    const basename = path.basename(file).toLowerCase();
    if (FORBIDDEN_FILENAMES.has(basename) || basename.startsWith('.env')) {
      errors.push(`${relative}: environment or credential file is not allowed`);
    }
    if (MEDIA_EXTENSIONS.has(extension)) errors.push(`${relative}: runtime/media artifact is not source`);
    if (relative.includes('.snapshot.')) errors.push(`${relative}: source snapshot is not allowed`);
    if (/(?:^|\/)(?:actions|acquisition-manifest|recording-manifest)\.json$/i.test(relative)) {
      errors.push(`${relative}: runtime manifest is not source`);
    }
    const buffer = fs.readFileSync(file);
    if (buffer.length > 2 * 1024 * 1024) {
      errors.push(`${relative}: file is too large for the source-only tree`);
      continue;
    }
    if (buffer.includes(0)) {
      errors.push(`${relative}: binary file is not allowed in the source-only tree`);
      continue;
    }
    const content = buffer.toString('utf8');
    const contentIssues = extension === '.json'
      ? inspectJsonContent(content, relative)
      : sourceContentIssues(content);
    for (const issue of contentIssues) errors.push(`${relative}: ${issue}`);
    for (const [label, pattern] of forbiddenContent) {
      if (pattern.test(content)) errors.push(`${relative}: ${label}`);
    }
  }
  return errors;
}

function main() {
  const errors = scanTree();
  if (errors.length) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('sanitized source tree: ok\n');
  }
}

if (require.main === module) main();

module.exports = { inspectJsonContent, scanTree };
