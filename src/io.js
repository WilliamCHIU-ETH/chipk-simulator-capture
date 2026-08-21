'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, file);
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

module.exports = { readJson };
