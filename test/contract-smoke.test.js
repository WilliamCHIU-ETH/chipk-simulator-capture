'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { capabilities } = require('../bin/chipk-capture');

test('capability handshake is versioned and explicitly contract-only', () => {
  const value = capabilities();
  assert.equal(value.schemaVersion, 1);
  assert.equal(value.providerId, 'chipk-simulator-capture');
  assert.equal(value.productionReady, false);
  assert.deepEqual(value.operations, []);
  assert.ok(value.limitations.includes('contract_only'));
});
