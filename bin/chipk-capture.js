#!/usr/bin/env node

'use strict';

const packageJson = require('../package.json');

function capabilities() {
  return {
    schemaVersion: 1,
    providerId: 'chipk-simulator-capture',
    toolVersion: packageJson.version,
    productionReady: false,
    operations: [],
    contracts: {
      request: 'contracts/capture-request.schema.json',
      result: 'contracts/capture-result.schema.json',
    },
    limitations: ['contract_only', 'simulator_implementation_not_published'],
  };
}

function main(argv) {
  const command = argv[0];
  if (command === '--version' || command === 'version') {
    process.stdout.write(`${packageJson.version}\n`);
    return 0;
  }
  if (command === 'capabilities') {
    process.stdout.write(`${JSON.stringify(capabilities(), null, 2)}\n`);
    return 0;
  }
  process.stderr.write('Usage: chipk-capture --version | capabilities --json\n');
  return 2;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { capabilities, main };
