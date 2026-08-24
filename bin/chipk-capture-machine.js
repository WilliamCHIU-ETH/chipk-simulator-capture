#!/usr/bin/env node

'use strict';

const { main } = require('../src/environment-doctor-cli');

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
