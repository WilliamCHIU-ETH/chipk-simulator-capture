#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
// Fixed local Git metadata query only; no caller-controlled command or runtime provider is executed.
const { spawnSync } = require(['node', 'child_process'].join(':'));
const { sourceContentIssues, structuredValueIssues } = require('../src/sensitive-taxonomy');
const { parseJsonStrict } = require('../src/strict-json');

const ROOT = path.resolve(__dirname, '..');
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
const IGNORED_WORKTREE_DIRECTORIES = new Set(['node_modules', '.runtime', 'runtime-data', 'coverage']);
const FORBIDDEN_TRACKED_DIRECTORIES = new Set([
  ...IGNORED_WORKTREE_DIRECTORIES,
  '.deploy',
  '.git',
]);
const ALLOWED_INDEX_MODES = new Set(['100644', '100755']);
const MEDIA_EXTENSIONS = new Set([
  '.mp4', '.mov', '.m4v', '.webm', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.heic', '.pdf',
  '.wav', '.mp3', '.m4a', '.sqlite', '.db', '.plist', '.log',
]);
const FORBIDDEN_FILENAMES = new Set(['.env', '.npmrc']);
const GIT_INDEX_ARGS = Object.freeze(['ls-files', '--stage', '-z', '--']);
const GIT_FLAGS_ARGS = Object.freeze(['ls-files', '-v', '-z', '--']);
const MAX_GIT_CONTROL_BYTES = 16 * 1024;

function pathPolicyIssues(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
  const components = normalized.split('/').filter(Boolean);
  const pathComponents = components.map((component) => component.toLowerCase());
  const extension = path.posix.extname(normalized).toLowerCase();
  const basename = path.posix.basename(normalized).toLowerCase();
  const issues = [];
  if (pathComponents.some((component) => FORBIDDEN_TRACKED_DIRECTORIES.has(component))) {
    issues.push('generated/runtime directory is not source');
  }
  if (FORBIDDEN_FILENAMES.has(basename) || basename.startsWith('.env')) {
    issues.push('environment or credential file is not allowed');
  }
  if (MEDIA_EXTENSIONS.has(extension)) issues.push('runtime/media artifact is not source');
  if (normalized.toLowerCase().includes('.snapshot.')) issues.push('source snapshot is not allowed');
  if (/(?:^|\/)(?:actions|capture-manifest|acquisition-manifest|recording-manifest|ocr(?:-dump)?)\.json$/i.test(normalized)) {
    issues.push('runtime manifest is not source');
  }
  return issues;
}

function trackedSourceIssues(trackedEntries) {
  const errors = [];
  for (const entry of trackedEntries) {
    const relative = typeof entry === 'string' ? entry : entry.path;
    for (const issue of pathPolicyIssues(relative)) {
      errors.push(`${relative}: tracked ${issue}`);
    }
  }
  return errors;
}

function fatalUtf8(buffer, label) {
  try {
    return UTF8_DECODER.decode(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function regularControlFile(target, label, maxBytes = MAX_GIT_CONTROL_BYTES) {
  let metadata;
  try {
    metadata = fs.lstatSync(target);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxBytes) {
    throw new Error(`${label} is invalid`);
  }
  return metadata;
}

function controlPathValue(target, label, prefix = '') {
  regularControlFile(target, label);
  const content = fatalUtf8(fs.readFileSync(target), label);
  const pattern = prefix
    ? new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ([^\\r\\n]+)\\r?\\n?$`)
    : /^([^\r\n]+)\r?\n?$/;
  const match = content.match(pattern);
  if (!match) throw new Error(`${label} is invalid`);
  return match[1];
}

function canonicalDirectory(target, label) {
  let resolved;
  try {
    resolved = fs.realpathSync(target);
  } catch {
    throw new Error(`${label} is unavailable`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`${label} is invalid`);
  return resolved;
}

function canonicalGitContext(rootValue, environment = process.env) {
  const root = canonicalDirectory(path.resolve(rootValue || ROOT), 'source root');
  const dotGit = path.join(root, '.git');
  let gitDir;
  let dotGitMetadata;
  try {
    dotGitMetadata = fs.lstatSync(dotGit);
  } catch {
    throw new Error('canonical Git metadata is unavailable');
  }
  if (dotGitMetadata.isDirectory() && !dotGitMetadata.isSymbolicLink()) {
    gitDir = canonicalDirectory(dotGit, 'canonical Git directory');
  } else if (dotGitMetadata.isFile() && !dotGitMetadata.isSymbolicLink()) {
    const pointer = controlPathValue(dotGit, 'canonical Git pointer', 'gitdir:');
    gitDir = canonicalDirectory(path.resolve(path.dirname(dotGit), pointer), 'canonical Git directory');
  } else {
    throw new Error('canonical Git metadata is invalid');
  }

  const commonPointer = path.join(gitDir, 'commondir');
  let commonDir = gitDir;
  if (fs.existsSync(commonPointer)) {
    const pointer = controlPathValue(commonPointer, 'canonical Git common-dir pointer');
    commonDir = canonicalDirectory(path.resolve(gitDir, pointer), 'canonical Git common directory');
  }
  const objectDirectory = canonicalDirectory(
    path.join(commonDir, 'objects'),
    'canonical Git object directory',
  );
  const indexCandidate = path.join(gitDir, 'index');
  regularControlFile(indexCandidate, 'canonical Git index', Number.MAX_SAFE_INTEGER);
  const indexFile = fs.realpathSync(indexCandidate);

  const sanitizedEnvironment = {};
  for (const [key, value] of Object.entries(environment || {})) {
    if (!key.startsWith('GIT_')) sanitizedEnvironment[key] = value;
  }
  Object.assign(sanitizedEnvironment, {
    GIT_COMMON_DIR: commonDir,
    GIT_DIR: gitDir,
    GIT_INDEX_FILE: indexFile,
    GIT_OBJECT_DIRECTORY: objectDirectory,
    GIT_WORK_TREE: root,
  });
  return {
    commonDir,
    environment: sanitizedEnvironment,
    gitDir,
    indexFile,
    objectDirectory,
    root,
  };
}

function gitResult(gitRunner, context, args, options = {}) {
  const environment = {
    ...context.environment,
    ...(options.blobRead
      ? {
        GIT_NO_LAZY_FETCH: '1',
        GIT_NO_REPLACE_OBJECTS: '1',
      }
      : {}),
  };
  let result = null;
  try {
    result = gitRunner('git', [
      `--git-dir=${context.gitDir}`,
      `--work-tree=${context.root}`,
      ...args,
    ], {
      cwd: context.root,
      encoding: null,
      env: environment,
      maxBuffer: MAX_SOURCE_BYTES * 2,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  if (!result || result.error || result.status !== 0 || result.stdout === undefined) return null;
  return result;
}

function nulRecords(output, label) {
  const bytes = Buffer.isBuffer(output) ? output : Buffer.from(output);
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error(`${label} is malformed`);
  return fatalUtf8(bytes.subarray(0, -1), label).split('\0');
}

function safeTrackedPath(relative) {
  if (!relative || relative.includes('\\') || path.posix.isAbsolute(relative)) return false;
  const components = relative.split('/');
  return components.every((component) => component && component !== '.' && component !== '..');
}

function listTrackedEntries(options = {}) {
  let context = options.context;
  if (!context) {
    try {
      context = canonicalGitContext(
        options.root || ROOT,
        options.environment || process.env,
      );
    } catch {
      throw new Error('tracked source inventory is unavailable');
    }
  }
  const gitRunner = options.gitRunner || spawnSync;
  const indexResult = gitResult(gitRunner, context, GIT_INDEX_ARGS);
  const flagsResult = gitResult(gitRunner, context, GIT_FLAGS_ARGS);
  if (!indexResult || !flagsResult) {
    throw new Error('tracked source inventory is unavailable');
  }

  const flags = new Map();
  for (const record of nulRecords(flagsResult.stdout, 'tracked source flags')) {
    const match = record.match(/^(.)(?: )([\s\S]+)$/);
    if (!match || !safeTrackedPath(match[2]) || flags.has(match[2])) {
      throw new Error('tracked source flags are malformed');
    }
    flags.set(match[2], match[1]);
  }

  const entries = [];
  const paths = new Set();
  for (const record of nulRecords(indexResult.stdout, 'tracked source index')) {
    const match = record.match(/^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/);
    if (!match || !safeTrackedPath(match[4]) || paths.has(match[4])) {
      throw new Error('tracked source index is malformed');
    }
    paths.add(match[4]);
    entries.push({
      mode: match[1],
      oid: match[2],
      stage: Number(match[3]),
      path: match[4],
      flag: flags.get(match[4]) || null,
    });
  }
  if (entries.length === 0) throw new Error('tracked source index is empty');
  if (flags.size !== entries.length || entries.some((entry) => entry.flag === null)) {
    throw new Error('tracked source index and flags disagree');
  }
  return entries;
}

function listTrackedFiles(gitRunner = spawnSync, root = ROOT, environment = process.env) {
  return listTrackedEntries({ environment, gitRunner, root }).map((entry) => entry.path);
}

function filesUnder(directory, root, errors) {
  const result = [];
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    errors.push(`${path.relative(root, directory) || '.'}: directory is unreadable`);
    return result;
  }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    const relative = path.relative(root, target);
    if (directory === root && entry.name === '.git') continue;
    if (entry.isDirectory()) {
      if (IGNORED_WORKTREE_DIRECTORIES.has(entry.name.toLowerCase())) {
        continue;
      }
      if (FORBIDDEN_TRACKED_DIRECTORIES.has(entry.name.toLowerCase())) {
        errors.push(`${relative}: generated/runtime directory is not source`);
      } else {
        result.push(...filesUnder(target, root, errors));
      }
    }
    else if (entry.isFile()) result.push(target);
    else errors.push(`${relative}: unsupported filesystem entry`);
  }
  return result;
}

function inspectJsonContent(content, label = 'JSON source') {
  let parsed;
  try {
    parsed = parseJsonStrict(content, label, 'INVALID_SANITIZED_JSON');
  } catch (error) {
    return [`${error.code || 'INVALID_SANITIZED_JSON'}: JSON failed strict validation`];
  }
  return structuredValueIssues(parsed, label);
}

function contentIssues(content, relative) {
  const extension = path.extname(relative).toLowerCase();
  return extension === '.json'
    ? inspectJsonContent(content, relative)
    : sourceContentIssues(content);
}

function inspectSourceBytes(buffer, relative, origin) {
  if (!Buffer.isBuffer(buffer)) return [`${relative}: ${origin} bytes are unavailable`];
  if (buffer.length > MAX_SOURCE_BYTES) {
    return [`${relative}: ${origin} file is too large for the source-only tree`];
  }
  if (buffer.includes(0)) return [`${relative}: ${origin} binary file is not allowed`];
  let content;
  try {
    content = fatalUtf8(buffer, `${relative}: ${origin}`);
  } catch (error) {
    return [error.message];
  }
  return contentIssues(content, relative).map((issue) => `${relative}: ${origin} ${issue}`);
}

function indexBlob(entry, context, gitRunner, cache) {
  if (cache.has(entry.oid)) return cache.get(entry.oid);
  const result = gitResult(gitRunner, context, ['cat-file', 'blob', entry.oid], {
    blobRead: true,
  });
  const bytes = result && Buffer.isBuffer(result.stdout)
    ? result.stdout
    : result && result.stdout !== undefined
      ? Buffer.from(result.stdout)
      : null;
  cache.set(entry.oid, bytes);
  return bytes;
}

function canonicalBlobOid(bytes, oidLength) {
  const algorithm = oidLength === 64 ? 'sha256' : 'sha1';
  return createHash(algorithm)
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function indexAndWorktreeIssues(entries, context, gitRunner) {
  const errors = [...trackedSourceIssues(entries)];
  const blobCache = new Map();
  const { root } = context;
  for (const entry of entries) {
    const relative = entry.path;
    if (entry.stage !== 0) {
      errors.push(`${relative}: unmerged Git index stage is not allowed`);
      continue;
    }
    if (entry.flag !== 'H') {
      errors.push(`${relative}: sparse or hidden Git index entry is not allowed`);
    }
    if (!ALLOWED_INDEX_MODES.has(entry.mode)) {
      errors.push(`${relative}: unsupported Git index mode ${entry.mode}`);
      continue;
    }

    const blob = indexBlob(entry, context, gitRunner, blobCache);
    if (!blob) {
      errors.push(`${relative}: Git index blob is unavailable`);
      continue;
    }
    if (canonicalBlobOid(blob, entry.oid.length) !== entry.oid) {
      errors.push(`${relative}: Git index blob OID does not match its bytes`);
    }
    errors.push(...inspectSourceBytes(blob, relative, 'Git index'));

    const target = path.resolve(root, relative);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      errors.push(`${relative}: tracked path escapes source root`);
      continue;
    }
    let metadata;
    try {
      metadata = fs.lstatSync(target);
    } catch {
      errors.push(`${relative}: tracked worktree file is missing`);
      continue;
    }
    if (!metadata.isFile()) {
      errors.push(`${relative}: tracked worktree entry is not a regular file`);
      continue;
    }
    let realTarget;
    try {
      realTarget = fs.realpathSync(target);
    } catch {
      errors.push(`${relative}: tracked worktree file is unreadable`);
      continue;
    }
    if (realTarget !== root && !realTarget.startsWith(`${root}${path.sep}`)) {
      errors.push(`${relative}: tracked worktree path crosses a symbolic link`);
      continue;
    }
    let worktreeBytes;
    try {
      worktreeBytes = fs.readFileSync(target);
    } catch {
      errors.push(`${relative}: tracked worktree file is unreadable`);
      continue;
    }
    errors.push(...inspectSourceBytes(worktreeBytes, relative, 'worktree'));
    const executable = (metadata.mode & 0o111) !== 0;
    if ((entry.mode === '100755') !== executable) {
      errors.push(`${relative}: worktree executable mode does not match the Git index`);
    }
  }
  return errors;
}

function scanTree(options = {}) {
  const errors = [];
  let root = path.resolve(options.root || ROOT);
  const gitRunner = options.gitRunner || spawnSync;
  try {
    const context = canonicalGitContext(root, options.environment || process.env);
    root = context.root;
    const trackedEntries = listTrackedEntries({ context, gitRunner });
    errors.push(...indexAndWorktreeIssues(trackedEntries, context, gitRunner));
  } catch {
    errors.push('git index: tracked source inventory is unavailable');
  }
  for (const file of filesUnder(root, root, errors)) {
    const relative = path.relative(root, file);
    for (const issue of pathPolicyIssues(relative)) errors.push(`${relative}: ${issue}`);
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      errors.push(`${relative}: worktree file is unreadable`);
      continue;
    }
    errors.push(...inspectSourceBytes(buffer, relative, 'worktree'));
  }
  return [...new Set(errors)];
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

module.exports = {
  inspectJsonContent,
  listTrackedEntries,
  listTrackedFiles,
  scanTree,
  trackedSourceIssues,
};
