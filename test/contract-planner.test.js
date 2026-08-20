'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const catalogFixture = require('../fixtures/synthetic/catalog.json');
const requestFixture = require('../fixtures/synthetic/request.json');
const { canonicalCatalogDigest, validateCatalog } = require('../src/catalog');
const { validateRequest } = require('../src/contract');
const { planRequest } = require('../src/planner');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('synthetic fixture produces a deterministic side-effect-free plan', () => {
  const first = planRequest(requestFixture, catalogFixture);
  const second = planRequest(clone(requestFixture), clone(catalogFixture));
  assert.deepEqual(second, first);
  assert.equal(first.catalogClassification, 'synthetic');
  assert.equal(first.route.id, 'chipk.fixture.stock-overview');
  assert.equal(first.route.fixedParams.view, 'overview');
  assert.match(first.route.resolvedUrl, /^chipk-fixture:\/\//);
  assert.match(first.route.resolvedUrl, /stockid=0000/);
  assert.equal(first.verdicts.navigation, 'not_executed');
  assert.equal(first.verdicts.material, 'not_executed');
});

test('request contract rejects undeclared input instead of silently accepting it', () => {
  const input = clone(requestFixture);
  input.target.fixedViewOverride = 'unsafe';
  assert.throws(() => validateRequest(input), { code: 'INVALID_REQUEST' });
});

test('planner rejects an operation not allowlisted by the route', () => {
  const input = clone(requestFixture);
  input.operation = 'record';
  assert.throws(() => planRequest(input, catalogFixture), { code: 'UNSUPPORTED_OPERATION' });
});

test('catalog rejects private endpoints and fixed-parameter collisions', () => {
  const privateCatalog = clone(catalogFixture);
  privateCatalog.baseUrl = 'http://localhost/catalog';
  assert.throws(() => validateCatalog(privateCatalog), { code: 'INVALID_CATALOG' });

  const collisionCatalog = clone(catalogFixture);
  collisionCatalog.routes[0].fixedParams.stockid = 'fixed';
  assert.throws(() => validateCatalog(collisionCatalog), { code: 'INVALID_CATALOG' });
});

test('production catalogs reject local, insecure, IPv6, and credential-bearing URLs', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const baseUrl of [
    'file:' + '///private/tmp/private-capture',
    'http:' + '//example.com/catalog',
    'http:' + '//[::1]/catalog',
    'https:' + '//user:secret@example.com/catalog',
  ]) {
    assert.throws(() => validateCatalog({ ...base, baseUrl }), { code: 'INVALID_CATALOG' });
  }
  assert.equal(validateCatalog({ ...base, baseUrl: 'https:' + '//example.com/catalog' }).classification, 'production-reviewed');
});

test('catalog normalizes query and fixed parameter strings before planning', () => {
  const input = clone(catalogFixture);
  input.routes[0].queryParams.stockId = ' stockid ';
  input.routes[0].fixedParams.view = ' overview ';
  const plan = planRequest(requestFixture, input);
  assert.match(plan.route.resolvedUrl, /[?&]stockid=0000(?:&|$)/);
  assert.doesNotMatch(plan.route.resolvedUrl, /%20stockid%20/);
  assert.equal(plan.route.fixedParams.view, 'overview');
});

test('catalog rejects production classification without a verified digest', () => {
  const input = clone(catalogFixture);
  input.classification = 'production-reviewed';
  assert.throws(() => validateCatalog(input), { code: 'INVALID_CATALOG' });
});

test('catalog digest is stable across object key ordering', () => {
  const reordered = {
    routes: clone(catalogFixture.routes),
    baseUrl: catalogFixture.baseUrl,
    classification: catalogFixture.classification,
    catalogVersion: catalogFixture.catalogVersion,
    schemaVersion: catalogFixture.schemaVersion,
  };
  assert.equal(canonicalCatalogDigest(reordered), canonicalCatalogDigest(catalogFixture));
});
