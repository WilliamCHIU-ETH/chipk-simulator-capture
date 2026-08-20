'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const requestSchema = require('../contracts/capture-request.schema.json');
const resultSchema = require('../contracts/capture-result.schema.json');
const {
  MODES,
  NON_BLANK_PATTERN_SOURCE,
  OPERATIONS,
  REQUEST_FIELDS,
  ROUTE_ID_PATTERN_SOURCE,
  TARGET_FIELDS,
} = require('../src/contract');

function sorted(values) {
  return [...values].sort();
}

test('request schema stays aligned with the runtime validator constants', () => {
  assert.equal(requestSchema.additionalProperties, false);
  assert.deepEqual(sorted(requestSchema.required), sorted(REQUEST_FIELDS));
  assert.deepEqual(sorted(Object.keys(requestSchema.properties)), sorted(REQUEST_FIELDS));
  assert.deepEqual(requestSchema.properties.operation.enum, [...OPERATIONS]);
  assert.deepEqual(requestSchema.properties.mode.enum, [...MODES]);
  assert.deepEqual(sorted(Object.keys(requestSchema.properties.target.properties)), sorted(TARGET_FIELDS));
  assert.equal(requestSchema.properties.target.additionalProperties, false);
  assert.equal(requestSchema.properties.target.properties.routeId.pattern, ROUTE_ID_PATTERN_SOURCE);
  assert.equal(requestSchema.properties.requestId.pattern, NON_BLANK_PATTERN_SOURCE);
  assert.equal(requestSchema.properties.outputDirectory.pattern, NON_BLANK_PATTERN_SOURCE);
  for (const field of ['stockId', 'stockName', 'recipeId']) {
    assert.equal(requestSchema.properties.target.properties[field].pattern, NON_BLANK_PATTERN_SOURCE);
  }
});

test('result schema retains the closed source-only result envelope', () => {
  assert.equal(resultSchema.additionalProperties, false);
  assert.deepEqual(
    sorted(resultSchema.required),
    sorted(['contractVersion', 'requestId', 'provider', 'status', 'artifacts', 'evidence', 'error']),
  );
  assert.equal(resultSchema.properties.requestId.pattern, NON_BLANK_PATTERN_SOURCE);
  assert.equal(resultSchema.properties.provider.additionalProperties, false);
  assert.deepEqual(sorted(resultSchema.properties.provider.required), ['id', 'toolVersion']);
  assert.equal(resultSchema.properties.provider.properties.toolVersion.pattern, NON_BLANK_PATTERN_SOURCE);
  assert.equal(resultSchema.properties.error.additionalProperties, false);
});
