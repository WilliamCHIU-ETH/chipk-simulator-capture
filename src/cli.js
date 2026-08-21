'use strict';

const packageJson = require('../package.json');
const syntheticCatalog = require('../fixtures/synthetic/catalog.json');
const { ContractError } = require('./errors');
const { createProvider } = require('./provider');
const { readJson } = require('./io');

function parseFlags(args) {
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json' || arg === '--authorize-run' || arg === '--confirm-dedicated-simulator') {
      flags[arg.slice(2)] = true;
      continue;
    }
    if (arg === '--request' || arg === '--catalog') {
      const value = args[index + 1];
      if (!value || value.startsWith('--')) throw new ContractError('INVALID_CLI', `${arg} requires a path`);
      flags[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new ContractError('INVALID_CLI', `unsupported argument: ${arg}`);
  }
  return flags;
}

function printJson(stream, value) {
  stream.write(`${JSON.stringify(value, null, 2)}\n`);
}

function createDefaultProvider(catalog = syntheticCatalog) {
  return createProvider({ catalog, toolVersion: packageJson.version });
}

function usage() {
  return 'Usage: chipk-capture --version | capabilities [--catalog <file>] --json | plan --request <file> [--catalog <file>] --json | capture|record --request <file> --json\n';
}

async function main(argv, streams = { stdout: process.stdout, stderr: process.stderr }, cwd = process.cwd()) {
  try {
    const [command, ...args] = argv;
    if (command === '--version' || command === 'version') {
      streams.stdout.write(`${packageJson.version}\n`);
      return 0;
    }
    if (command === 'capabilities') {
      const flags = parseFlags(args);
      const catalog = flags.catalog ? readJson(flags.catalog, cwd) : syntheticCatalog;
      printJson(streams.stdout, createDefaultProvider(catalog).capabilities());
      return 0;
    }
    if (!['plan', 'capture', 'record'].includes(command)) {
      streams.stderr.write(usage());
      return 2;
    }

    const flags = parseFlags(args);
    if (!flags.request) throw new ContractError('INVALID_CLI', '--request is required');
    const request = readJson(flags.request, cwd);
    const catalog = flags.catalog ? readJson(flags.catalog, cwd) : syntheticCatalog;
    const provider = createDefaultProvider(catalog);

    if (command === 'plan') {
      printJson(streams.stdout, provider.plan(request));
      return 0;
    }
    if (request.operation !== command.replace('capture', 'screenshot')) {
      throw new ContractError('INVALID_REQUEST', `request operation does not match ${command}`);
    }
    const result = await provider.execute(request, {
      operatorAuthorized: flags['authorize-run'] === true,
      dedicatedSimulatorConfirmed: flags['confirm-dedicated-simulator'] === true,
    });
    printJson(streams.stdout, result);
    return result.status === 'completed' ? 0 : 3;
  } catch (error) {
    const code = error instanceof ContractError ? error.code : 'UNEXPECTED_ERROR';
    const message = error instanceof ContractError
      ? error.message
      : 'Command failed without a publishable diagnostic.';
    printJson(streams.stderr, { error: { code, message } });
    return 2;
  }
}

module.exports = { createDefaultProvider, main, parseFlags, usage };
