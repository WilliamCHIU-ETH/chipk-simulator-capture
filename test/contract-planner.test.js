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

function ipv4(...octets) {
  return octets.join('.');
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
  privateCatalog.baseUrl = ['http:/', '/local', 'host/catalog'].join('');
  assert.throws(() => validateCatalog(privateCatalog), { code: 'INVALID_CATALOG' });

  const collisionCatalog = clone(catalogFixture);
  collisionCatalog.routes[0].fixedParams.stockid = 'fixed';
  assert.throws(() => validateCatalog(collisionCatalog), { code: 'INVALID_CATALOG' });
});

test('production catalogs reject explicit non-public labels anywhere in a hostname', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const baseUrl of [
    'file:' + '///pri' + 'vate/t' + 'mp/private-capture',
    'http:' + '/' + '/example.com/catalog',
    'http:' + '/' + '/[' + ['', '', '1'].join(':') + ']/catalog',
    'https:' + '/' + '/user:secret@exam' + 'ple.com/catalog',
    'https:' + '/' + '/local' + 'host./catalog',
    'https:' + '/' + '/local' + 'host../catalog',
    'https:' + '/' + '/service.local' + 'host./catalog',
    'https:' + '/' + '/lo' + 'cal./catalog',
    'https:' + '/' + '/service.lo' + 'cal../catalog',
    'https:' + '/' + '/in' + 'ternal./catalog',
    'https:' + '/' + '/service.in' + 'ternal../catalog',
    'https:' + '/' + '/api.in' + 'ternal.example.com./catalog',
    'https:' + '/' + '/api.lo' + 'cal.example.com/catalog',
    'https:' + '/' + '/api.pri' + 'vate.example.com/catalog',
    'https:' + '/' + '/api.non-' + 'public.example.com/catalog',
    'https:' + '/' + '/api.non' + 'public.example.com/catalog',
  ]) {
    assert.throws(() => validateCatalog({ ...base, baseUrl }), { code: 'INVALID_CATALOG' });
  }

  for (const hostname of ['dev.to', 'test.com', 'builder.io', 'sandbox.com']) {
    const publicCatalog = validateCatalog({ ...base, baseUrl: `https://${hostname}../catalog` });
    assert.equal(publicCatalog.baseUrl, `https://${hostname}/catalog`);
  }
});

test('production catalogs reject non-public IPv4 ranges', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const hostname of [
    ipv4(0, 0, 0, 1),
    ipv4(10, 0, 0, 1),
    ipv4(100, 64, 0, 1),
    ipv4(100, 127, 255, 254),
    ipv4(127, 0, 0, 1),
    ipv4(169, 254, 1, 1),
    ipv4(172, 16, 0, 1),
    ipv4(172, 31, 255, 254),
    ipv4(192, 0, 0, 1),
    ipv4(192, 0, 2, 1),
    ipv4(192, 88, 99, 1),
    ipv4(192, 168, 0, 1),
    ipv4(198, 18, 0, 1),
    ipv4(198, 19, 255, 254),
    ipv4(198, 51, 100, 1),
    ipv4(203, 0, 113, 1),
    ipv4(224, 0, 0, 1),
    ipv4(239, 255, 255, 255),
    ipv4(240, 0, 0, 1),
    ipv4(255, 255, 255, 255),
  ]) {
    assert.throws(
      () => validateCatalog({ ...base, baseUrl: `https://${hostname}/catalog` }),
      { code: 'INVALID_CATALOG' },
    );
  }

  for (const hostname of [
    ipv4(8, 8, 8, 8),
    ipv4(100, 128, 0, 1),
    ipv4(198, 17, 255, 255),
    ipv4(203, 0, 114, 1),
  ]) {
    assert.equal(
      validateCatalog({ ...base, baseUrl: `https://${hostname}/catalog` }).baseUrl,
      `https://${hostname}/catalog`,
    );
  }
});

test('production catalogs classify legacy IPv4 independently of URL scheme', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const protocol of ['https:', 'chipk:']) {
    for (const hostname of [
      '127.1..',
      '127.1...',
      '0x7f000001..',
      '2130706433..',
      '0300.0250.0000.0001..',
    ]) {
      assert.throws(
        () => validateCatalog({ ...base, baseUrl: `${protocol}//${hostname}/catalog` }),
        { code: 'INVALID_CATALOG' },
      );
    }
  }

  for (const protocol of ['https:', 'chipk:']) {
    for (const [hostname, canonical] of [
      ['8.8.8..', ipv4(8, 8, 0, 8)],
      ['0x08080808..', ipv4(8, 8, 8, 8)],
      ['134744072..', ipv4(8, 8, 8, 8)],
      ['0010.0010.0010.0010..', ipv4(8, 8, 8, 8)],
    ]) {
      assert.equal(
        validateCatalog({ ...base, baseUrl: `${protocol}//${hostname}/catalog` }).baseUrl,
        `${protocol}//${canonical}/catalog`,
      );
    }
  }
});

test('production catalogs reject special-use and unqualified DNS namespaces', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const protocol of ['https:', 'chipk:']) {
    for (const hostname of [
      'capture.invalid',
      'service.test',
      'service.example',
      'home.arpa',
      'router.home.arpa',
      'service.onion',
      'service.alt',
      'intranet',
    ]) {
      assert.throws(
        () => validateCatalog({ ...base, baseUrl: `${protocol}//${hostname}/catalog` }),
        { code: 'INVALID_CATALOG' },
      );
    }
  }

  for (const hostname of [
    'example.com',
    'test.com',
    'invalid.com',
    'home.arpa.com',
    'intranet.example.com',
  ]) {
    assert.equal(
      validateCatalog({ ...base, baseUrl: `https://${hostname}/catalog` }).baseUrl,
      `https://${hostname}/catalog`,
    );
  }
});

test('production catalogs reject special-use IPv6 while allowing public IPv6', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const hostname of [
    '::',
    '::1',
    `::ffff:${ipv4(192, 168, 0, 1)}`,
    '64:ff9b::c000:201',
    '64:ff9b:1::1',
    '100::1',
    '2001::1',
    '2001:2::1',
    '2001:10::1',
    '2001:20::1',
    '2001:db8::1',
    '2002:c000:201::1',
    '3fff::1',
    '5f00::1',
    'fc00::1',
    'fdff::1',
    'fe80::1',
    'fec0::1',
    'ff02::1',
  ]) {
    assert.throws(
      () => validateCatalog({ ...base, baseUrl: `https://[${hostname}]/catalog` }),
      { code: 'INVALID_CATALOG' },
    );
  }

  for (const hostname of ['2001:4860:4860::8888', '2606:4700:4700::1111']) {
    assert.equal(
      validateCatalog({ ...base, baseUrl: `https://[${hostname}]/catalog` }).baseUrl,
      `https://[${hostname}]/catalog`,
    );
  }
});

test('production catalogs canonicalize trailing dots on public hosts', () => {
  const base = clone(catalogFixture);
  base.classification = 'production-reviewed';
  base.sourceDigest = 'a'.repeat(64);
  for (const baseUrl of [
    'https:' + '//10.' + '0.0.1../catalog',
    'https:' + '//127.' + '0.0.1../catalog',
    'https:' + '//169.' + '254.1.1../catalog',
    'https:' + '//172.' + '16.0.1../catalog',
    'https:' + '//192.' + '168.0.1../catalog',
  ]) {
    assert.throws(() => validateCatalog({ ...base, baseUrl }), { code: 'INVALID_CATALOG' });
  }
  const publicCatalog = validateCatalog({ ...base, baseUrl: 'https:' + '//example.com../catalog' });
  assert.equal(publicCatalog.classification, 'production-reviewed');
  assert.equal(publicCatalog.baseUrl, 'https:' + '//example.com/catalog');
});

test('synthetic catalogs accept canonical public fixture hosts with trailing dots', () => {
  const input = clone(catalogFixture);
  input.baseUrl = 'chipk-fixture:' + '//capture.invalid../landing';
  assert.equal(validateCatalog(input).baseUrl, 'chipk-fixture:' + '//capture.invalid/landing');

  for (const hostname of ['other.invalid', 'sub.capture.invalid', 'capture.test']) {
    assert.throws(
      () => validateCatalog({ ...input, baseUrl: `chipk-fixture://${hostname}/landing` }),
      { code: 'INVALID_CATALOG' },
    );
  }
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
