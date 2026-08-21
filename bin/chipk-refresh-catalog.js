#!/usr/bin/env node

'use strict';

const { ContractError } = require('../src/errors');
const { refreshCatalog } = require('../src/catalog-compiler');

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (!['--input', '--output'].includes(argument)) {
      throw new ContractError('INVALID_CLI', `unsupported argument: ${argument}`);
    }
    if (Object.hasOwn(flags, argument)) {
      throw new ContractError('INVALID_CLI', `${argument} must be supplied exactly once`);
    }
    const value = args[index + 1];
    if (!value || value.startsWith('--')) {
      throw new ContractError('INVALID_CLI', `${argument} requires an explicit path`);
    }
    flags[argument] = value;
    index += 1;
  }
  if (!flags['--input'] || !flags['--output']) {
    throw new ContractError('INVALID_CLI', '--input and --output are both required');
  }
  return Object.freeze({ inputPath: flags['--input'], outputDirectory: flags['--output'] });
}

function printJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage() {
  return 'Usage: chipk-refresh-catalog --input <source-bundle.json> --output <existing-directory>\n';
}

async function main(argv, streams = { stdout: process.stdout, stderr: process.stderr }, cwd = process.cwd()) {
  try {
    const flags = parseFlags(argv);
    const result = refreshCatalog({ ...flags, cwd });
    printJson(streams.stdout, { ok: true, ...result });
    return 0;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : 'UNEXPECTED_ERROR';
    const message = error instanceof ContractError
      ? error.message
      : 'Catalog refresh failed without a publishable diagnostic.';
    printJson(streams.stderr, { error: { code, message }, usage: usage().trim() });
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { main, parseFlags, usage };
