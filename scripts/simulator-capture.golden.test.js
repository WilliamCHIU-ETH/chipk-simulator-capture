'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildPlan, suggestRoutes } = require('./simulator-capture');

const ROOT = path.resolve(__dirname, '..');
const catalog = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'config', 'simulator-capture.catalog.json'), 'utf8'),
);
const golden = JSON.parse(
  fs.readFileSync(
    path.join(
      ROOT,
      '.agents',
      'skills',
      'chipk-simulator-capture',
      'references',
      'golden-cases.json',
    ),
    'utf8',
  ),
);

for (const fixture of golden.cases) {
  test(`golden route: ${fixture.id}`, () => {
    const provided = fixture.params || {};
    const result = suggestRoutes(catalog, fixture.text, 5, provided);
    const candidates = result.suggestions.map((item) => item.route);

    if (fixture.expectedTopRoute) assert.equal(candidates[0], fixture.expectedTopRoute);
    if (fixture.expectedCandidates) {
      for (const route of fixture.expectedCandidates) assert.ok(candidates.includes(route));
      if (fixture.expectedCandidates.length === 0) assert.deepEqual(candidates, []);
    }
    assert.equal(result.requiresHumanChoice, fixture.expectedHumanChoice);

    if (!fixture.expectedTopRoute) return;
    const suggestion = result.suggestions[0];
    if (fixture.expectedResolvedParams) {
      assert.deepEqual(suggestion.resolvedParams, fixture.expectedResolvedParams);
    }
    const resolved = { ...provided, ...suggestion.resolvedParams };
    const plan = buildPlan(catalog, {
      route: fixture.expectedTopRoute,
      mode: fixture.mode,
      scriptDate: fixture.scriptDate,
      stockId: resolved.stockid,
      stockName: resolved.stockname,
    });
    for (const part of fixture.expectedUrlParts || []) assert.ok(plan.url.includes(part));
  });
}
