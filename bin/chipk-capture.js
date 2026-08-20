#!/usr/bin/env node

'use strict';

const { main } = require('../src/cli');

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
