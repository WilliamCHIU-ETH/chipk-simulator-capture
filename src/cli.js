'use strict';

const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');
const { ContractError } = require('./errors');
const { parseJsonStrict } = require('./strict-json');
const { createProvider } = require('./provider');
const { createRuntimeAdapter } = require('./runtime-adapter');

const MAX_REQUEST_BYTES = 256 * 1024;

function parseFlags(command, args) {
  const allowed = command === 'capabilities' ? new Set(['--json']) : new Set(['--request', '--json']);
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!allowed.has(argument)) {
      throw new ContractError('INVALID_CLI', `unsupported argument: ${argument}`);
    }
    if (Object.hasOwn(flags, argument)) {
      throw new ContractError('INVALID_CLI', `${argument} must not be repeated`);
    }
    if (argument === '--json') {
      flags.json = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ContractError('INVALID_CLI', '--request requires an absolute JSON file');
    }
    flags.request = value;
    index += 1;
  }
  if (!flags.json) throw new ContractError('INVALID_CLI', '--json is required');
  if (command === 'acquire' && !flags.request) {
    throw new ContractError('INVALID_CLI', '--request is required');
  }
  return flags;
}

function readRequest(filePath) {
  if (!path.isAbsolute(filePath)) {
    throw new ContractError('INVALID_CLI', '--request must be an absolute path');
  }
  let metadata;
  try {
    metadata = fs.lstatSync(filePath);
  } catch {
    throw new ContractError('INVALID_CLI', 'request file is unavailable');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_REQUEST_BYTES) {
    throw new ContractError('INVALID_CLI', 'request must be a small regular non-symbolic-link file');
  }
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    throw new ContractError('INVALID_CLI', 'request file is unreadable');
  }
  return parseJsonStrict(content, 'request', 'INVALID_REQUEST');
}

function printJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createDefaultProvider(options = {}) {
  return createProvider({
    runtimeAdapter: options.runtimeAdapter || createRuntimeAdapter(options.runtimeOptions),
    toolVersion: packageJson.version,
  });
}

function usage() {
  return [
    'Usage:',
    '  chipk-capture capabilities --json',
    '  chipk-capture acquire --request <absolute-json-file> --json',
  ].join('\n');
}

async function main(
  argv,
  streams = { stdout: process.stdout, stderr: process.stderr },
  options = {},
) {
  try {
    const [command, ...args] = argv;
    if (!['capabilities', 'acquire'].includes(command)) {
      throw new ContractError('INVALID_CLI', 'command must be capabilities or acquire');
    }
    const flags = parseFlags(command, args);
    const provider = options.provider || createDefaultProvider(options);
    if (command === 'capabilities') {
      printJson(streams.stdout, provider.capabilities());
      return 0;
    }
    const result = await provider.acquire(readRequest(flags.request));
    printJson(streams.stdout, result);
    return result.status === 'completed' ? 0 : 3;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : 'UNEXPECTED_ERROR';
    const message = error instanceof ContractError
      ? error.message
      : 'Command failed without a publishable diagnostic.';
    printJson(streams.stderr, { error: { code, message }, usage: usage() });
    return 2;
  }
}

module.exports = { createDefaultProvider, main, parseFlags, readRequest, usage };
