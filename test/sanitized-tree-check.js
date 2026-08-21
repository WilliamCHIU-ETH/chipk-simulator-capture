#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_PATHS = new Set([path.join(ROOT, '.git'), path.join(ROOT, 'node_modules')]);
const FORBIDDEN_DIRECTORIES = new Set(['runtime-data', 'coverage', '.deploy']);
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.png', '.jpg', '.jpeg', '.webp', '.heic',
  '.wav', '.mp3', '.m4a', '.sqlite', '.db', '.plist', '.log',
]);
const FORBIDDEN_FILENAMES = new Set(['.env', '.npmrc']);
const errors = [];

function filesUnder(directory) {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (SKIP_PATHS.has(target)) continue;
    if (entry.isDirectory()) {
      if (FORBIDDEN_DIRECTORIES.has(entry.name.toLowerCase())) {
        errors.push(`${path.relative(ROOT, target)}: generated/runtime directory is not source`);
      } else {
        result.push(...filesUnder(target));
      }
    }
    else if (entry.isFile()) result.push(target);
    else throw new Error(`unsupported filesystem entry: ${path.relative(ROOT, target)}`);
  }
  return result;
}

const forbiddenContent = [
  ['machine home path', new RegExp('/' + 'Users' + '/')],
  ['machine application path', new RegExp('/' + 'Applications' + '/')],
  ['private IPv4 address', /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
  ['company test identifier', new RegExp('@' + 'cmoney' + '\\.com\\.tw', 'i')],
  ['credential locator field', new RegExp('keychain' + '(?:Account|Service)', 'i')],
  ['login identifier field', new RegExp('login' + 'Identifier', 'i')],
  ['credential read command', new RegExp('find-' + 'generic-password', 'i')],
  ['runtime process module', new RegExp('node:' + 'child_process')],
  ['internal builder URL', new RegExp('https?://[^\\s"\'<>]*' + 'builder', 'i')],
  ['company service URL', new RegExp('https?://[^\\s"\'<>]*' + 'cmoney', 'i')],
];

for (const file of filesUnder(ROOT)) {
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
  for (const [label, pattern] of forbiddenContent) {
    if (pattern.test(content)) errors.push(`${relative}: ${label}`);
  }
}

if (errors.length) {
  process.stderr.write(`${errors.join('\n')}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write('sanitized source tree: ok\n');
}
