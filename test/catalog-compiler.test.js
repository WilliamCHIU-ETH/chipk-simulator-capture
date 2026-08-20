'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const sourceSchema = require('../contracts/source-bundle.schema.json');
const sourceFixture = require('../fixtures/synthetic/source-bundle.json');
const { main, parseFlags } = require('../bin/chipk-refresh-catalog');
const { canonicalCatalogDigest, validateCatalog } = require('../src/catalog');
const {
  TARGET_FILENAME,
  compileCatalogBytes,
  loadSourceBundle,
  refreshCatalog,
  validateOutputDirectory,
  validateSourceBundle,
} = require('../src/catalog-compiler');
const { createProvider } = require('../src/provider');
const {
  sensitiveFieldIssue,
  sourceContentIssues,
} = require('../src/sensitive-taxonomy');
const { inspectJsonContent } = require('./sanitized-tree-check');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function privateKeyMarkers() {
  const privateToken = ['PRI', 'VATE'].join('');
  const keyToken = ['K', 'EY'].join('');
  return [
    '',
    ['R', 'SA'].join(''),
    ['E', 'C'].join(''),
    ['OPEN', 'SSH'].join(''),
  ].map((kind) => [
    '-----',
    'BEGIN',
    ' ',
    kind,
    kind ? ' ' : '',
    privateToken,
    ' ',
    keyToken,
    '-----',
  ].join(''));
}

function streams() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (value) => { stdout += value; } },
    stderr: { write: (value) => { stderr += value; } },
    values: () => ({ stdout, stderr }),
  };
}

function makeRoot() {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  return fs.mkdtempSync(path.join(temporaryRoot, 'chipk-catalog-refresh-'));
}

function writeJson(target, value) {
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function writeText(target, value) {
  fs.writeFileSync(target, value, { flag: 'wx', mode: 0o600 });
}

function setup() {
  const root = makeRoot();
  const input = path.join(root, 'source-bundle.json');
  const output = path.join(root, 'output');
  fs.mkdirSync(output, { mode: 0o700 });
  writeJson(input, sourceFixture);
  return { root, input, output };
}

function cleanup(root) {
  fs.rmSync(root, { recursive: true, force: true });
}

test('source schema and runtime validator retain a closed versioned envelope', () => {
  assert.equal(sourceSchema.additionalProperties, false);
  assert.deepEqual(
    [...sourceSchema.required].sort(),
    ['baseUrl', 'catalogVersion', 'classification', 'routes', 'schemaVersion'],
  );
  assert.equal(sourceSchema.properties.routes.items.additionalProperties, false);
  assert.equal(sourceSchema.properties.routes.items.properties.fixedParams.items.additionalProperties, false);
  assert.equal(sourceSchema.properties.routes.items.properties.queryParams.items.additionalProperties, false);
  assert.doesNotThrow(() => validateSourceBundle(sourceFixture));
});

test('CLI requires one explicit input and output before any filesystem write', async () => {
  const { root, input, output } = setup();
  try {
    assert.throws(() => parseFlags([]), { code: 'INVALID_CLI' });
    assert.throws(() => parseFlags(['--input', input]), { code: 'INVALID_CLI' });
    assert.throws(() => parseFlags(['--output', output]), { code: 'INVALID_CLI' });
    assert.throws(() => parseFlags(['--input', input, '--input', input, '--output', output]), {
      code: 'INVALID_CLI',
    });

    const outputStreams = streams();
    assert.equal(await main(['--input', input], outputStreams, root), 2);
    assert.equal(fs.readdirSync(output).length, 0);
    assert.equal(JSON.parse(outputStreams.values().stderr).error.code, 'INVALID_CLI');
  } finally {
    cleanup(root);
  }
});

test('refresh writes a deterministic catalog and digest without changing build readiness', async () => {
  const first = setup();
  const second = setup();
  try {
    const firstStreams = streams();
    const secondStreams = streams();
    assert.equal(await main([
      '--input', first.input,
      '--output', first.output,
    ], firstStreams, first.root), 0);
    assert.equal(await main([
      '--input', second.input,
      '--output', second.output,
    ], secondStreams, second.root), 0);

    const firstBytes = fs.readFileSync(path.join(first.output, TARGET_FILENAME));
    const secondBytes = fs.readFileSync(path.join(second.output, TARGET_FILENAME));
    assert.deepEqual(secondBytes, firstBytes);
    const catalog = JSON.parse(firstBytes);
    assert.deepEqual(validateCatalog(catalog), catalog);
    assert.equal(catalog.sourceDigest, canonicalCatalogDigest(catalog));
    assert.equal(catalog.classification, 'synthetic');
    assert.match(catalog.sourceDigest, /^[a-f0-9]{64}$/);

    const result = JSON.parse(firstStreams.values().stdout);
    assert.equal(result.ok, true);
    assert.equal(result.targetFile, TARGET_FILENAME);
    assert.equal(result.digest, catalog.sourceDigest);
    assert.equal(Object.values(result).some((value) => String(value).includes(first.root)), false);
  } finally {
    cleanup(first.root);
    cleanup(second.root);
  }
});

test('equivalent route and object ordering produces identical catalog bytes', () => {
  const reordered = clone(sourceFixture);
  reordered.routes.reverse();
  reordered.routes[0].operations.reverse();
  reordered.routes[0].requiredParams.reverse();
  reordered.routes[0].queryParams.reverse();
  reordered.routes[0].fixedParams.reverse();
  const first = compileCatalogBytes(sourceFixture);
  const second = compileCatalogBytes(reordered);
  assert.equal(second.bytes, first.bytes);
  assert.equal(second.digest, first.digest);
});

test('a compiled production candidate is normalized but cannot approve its own digest', () => {
  const candidate = clone(sourceFixture);
  candidate.classification = 'production-reviewed';
  candidate.baseUrl = 'https://example.invalid';
  const compiled = compileCatalogBytes(candidate).catalog;
  assert.equal(compiled.baseUrl, 'https://example.invalid/');
  assert.equal(compiled.sourceDigest, canonicalCatalogDigest(compiled));

  const provider = createProvider({ catalog: compiled, toolVersion: 'test' });
  const capabilities = provider.capabilities();
  assert.equal(capabilities.productionReady, false);
  assert.deepEqual(capabilities.operations, []);
  assert.ok(capabilities.readiness.reasons.includes('catalog_digest_not_approved_by_build'));
});

test('input and output symbolic links and parent traversal fail without output', () => {
  const { root, input, output } = setup();
  const inputLink = path.join(root, 'source-link.json');
  const outputLink = path.join(root, 'output-link');
  fs.symlinkSync(input, inputLink);
  fs.symlinkSync(output, outputLink);
  try {
    assert.throws(() => refreshCatalog({ inputPath: inputLink, outputDirectory: output }), {
      code: 'INVALID_INPUT',
    });
    assert.throws(() => refreshCatalog({ inputPath: input, outputDirectory: outputLink }), {
      code: 'INVALID_OUTPUT',
    });
    assert.throws(() => refreshCatalog({
      inputPath: `${root}/safe/../source-bundle.json`,
      outputDirectory: output,
    }), { code: 'PATH_ESCAPE' });
    assert.throws(() => refreshCatalog({
      inputPath: input,
      outputDirectory: `${root}/safe/../output`,
    }), { code: 'PATH_ESCAPE' });
    assert.deepEqual(fs.readdirSync(output), []);
  } finally {
    cleanup(root);
  }
});

test('symbolic-link parent components and foreign-owned output fail closed', () => {
  const { root, input, output } = setup();
  const linkedRoot = path.join(root, 'linked-root');
  fs.symlinkSync(root, linkedRoot);
  try {
    assert.throws(() => refreshCatalog({
      inputPath: path.join(linkedRoot, path.basename(input)),
      outputDirectory: output,
    }), { code: 'PATH_ESCAPE' });
    assert.throws(() => refreshCatalog({
      inputPath: input,
      outputDirectory: path.join(linkedRoot, path.basename(output)),
    }), { code: 'PATH_ESCAPE' });

    if (typeof process.getuid === 'function') {
      const foreignFs = Object.create(fs);
      foreignFs.lstatSync = (target) => {
        const metadata = fs.lstatSync(target);
        if (path.resolve(target) !== path.resolve(output)) return metadata;
        const foreign = Object.create(metadata);
        Object.defineProperty(foreign, 'uid', { value: process.getuid() + 1 });
        return foreign;
      };
      assert.throws(() => validateOutputDirectory(output, root, { fsImpl: foreignFs }), {
        code: 'INVALID_OUTPUT',
      });
    }
    assert.deepEqual(fs.readdirSync(output), []);
  } finally {
    cleanup(root);
  }
});

test('schema mismatch, unknown fields, duplicate routes and duplicate fixed params fail closed', () => {
  const cases = [];
  const schemaMismatch = clone(sourceFixture);
  schemaMismatch.schemaVersion = 2;
  cases.push(schemaMismatch);

  const unknownTopLevel = clone(sourceFixture);
  unknownTopLevel.extra = true;
  cases.push(unknownTopLevel);

  const unknownRouteField = clone(sourceFixture);
  unknownRouteField.routes[0].extra = true;
  cases.push(unknownRouteField);

  const duplicateRoute = clone(sourceFixture);
  duplicateRoute.routes.push(clone(duplicateRoute.routes[0]));
  cases.push(duplicateRoute);

  const duplicateFixed = clone(sourceFixture);
  duplicateFixed.routes[0].fixedParams.push(clone(duplicateFixed.routes[0].fixedParams[0]));
  cases.push(duplicateFixed);

  for (const value of cases) {
    assert.throws(() => compileCatalogBytes(value), { code: 'INVALID_SOURCE_BUNDLE' });
  }
});

test('private endpoints, machine paths, persona fields and credential locators fail closed', () => {
  const privateEndpoint = clone(sourceFixture);
  privateEndpoint.baseUrl = ['http:/', '/192.', '168.1.20:8420/catalog'].join('');

  const machinePath = clone(sourceFixture);
  machinePath.routes[0].fixedParams[0].value = ['/', 'Users/example/private.json'].join('');

  const persona = clone(sourceFixture);
  persona.routes[0].fixedParams[0].name = ['per', 'sona'].join('');

  const credentialLocator = clone(sourceFixture);
  credentialLocator.routes[0].fixedParams[0].name = ['key', 'chainService'].join('');

  const embeddedEndpoint = clone(sourceFixture);
  embeddedEndpoint.routes[0].readinessTexts[0] = [
    'open http:/',
    '/12',
    '7.',
    '0.0.1/private',
  ].join('');

  const credentialQuery = clone(sourceFixture);
  credentialQuery.baseUrl = ['chipk-fixture:/', '/refresh.invalid/landing?access', 'Token=fixture'].join('');

  const companyHost = clone(sourceFixture);
  companyHost.baseUrl = ['https:/', '/www.c', 'money.tw/catalog'].join('');

  const internalHost = clone(sourceFixture);
  internalHost.baseUrl = ['https:/', '/api.intern', 'al.example.com/catalog'].join('');

  const internalLabelHost = clone(sourceFixture);
  internalLabelHost.baseUrl = ['https:/', '/api.te', 'st.example.com/catalog'].join('');

  const sharedAddress = clone(sourceFixture);
  sharedAddress.baseUrl = ['https:/', '/100.', '64.0.1/catalog'].join('');

  const benchmarkAddress = clone(sourceFixture);
  benchmarkAddress.baseUrl = ['https:/', '/198.', '18.0.1/catalog'].join('');

  const identityFields = [
    ['user', 'Id'].join(''),
    ['member', 'Id'].join(''),
    ['api', 'Key'].join(''),
    ['access', 'Key'].join(''),
    ['authoriz', 'ation'].join(''),
    ['acc', 'ount'].join(''),
    ['acc', 'ount', 'Name'].join(''),
    ['pro', 'file', 'Id'].join(''),
    ['pri', 'vate', 'Key'].join(''),
    ['cli', 'ent', 'Key'].join(''),
    ['o', 'auth', 'ClientId'].join(''),
    ['sign', 'ing', 'Key'].join(''),
    ['s', 'sh', 'Key'].join(''),
    ['key', 'Mater', 'ial'].join(''),
  ].map((name) => {
    const value = clone(sourceFixture);
    value.routes[0].fixedParams[0].name = name;
    return value;
  });

  const systemPaths = [
    ['/', 'etc/private.conf'].join(''),
    ['/', 'opt/private/tool'].join(''),
    ['/', 'usr/loc', 'al/private/tool'].join(''),
    ['/', 'Lib', 'rary/private/tool'].join(''),
    ['/', 'Sys', 'tem/private/tool'].join(''),
    ['/', 'v', 'ar/private/tool'].join(''),
    ['C:\\', 'Program', 'Data\\private\\tool'].join(''),
    ['\\\\', 'server', '\\share\\private'].join(''),
  ].map((systemPath) => {
    const value = clone(sourceFixture);
    value.routes[0].fixedParams[0].value = systemPath;
    return value;
  });

  const forbiddenIpv6Values = [
    ['', '', ''].join(':'),
    ['', '', '1'].join(':'),
    ['fd00', '', '1'].join(':'),
    ['fe80', '', '1'].join(':'),
    ['ff02', '', '1'].join(':'),
    ['fec0', '', '1'].join(':'),
    ['2001', 'db8', '', '1'].join(':'),
    ['2001', '4860', '4860', '', '8888'].join(':'),
  ].map((address) => {
    const value = clone(sourceFixture);
    value.routes[0].fixedParams[0].value = address;
    return value;
  });

  const privateKeyValues = privateKeyMarkers().map((marker) => {
    const value = clone(sourceFixture);
    value.routes[0].fixedParams[0].value = marker;
    return value;
  });

  for (const value of [
    privateEndpoint,
    machinePath,
    persona,
    credentialLocator,
    embeddedEndpoint,
    credentialQuery,
    companyHost,
    internalHost,
    internalLabelHost,
    sharedAddress,
    benchmarkAddress,
    ...identityFields,
    ...systemPaths,
    ...forbiddenIpv6Values,
    ...privateKeyValues,
  ]) {
    assert.throws(() => compileCatalogBytes(value), { code: 'PRIVATE_SOURCE_DATA' });
  }
});

test('token-aware field checks avoid substring false positives and ordinary source filenames', () => {
  for (const name of ['formFactor', 'platformFallback', 'teamFavorite']) {
    assert.equal(sensitiveFieldIssue(name), null);
    const value = clone(sourceFixture);
    value.routes[0].fixedParams[0].name = name;
    assert.doesNotThrow(() => compileCatalogBytes(value));
  }

  const sourceFilename = clone(sourceFixture);
  sourceFilename.routes[0].fixedParams[0].value = ['te', 'st.json'].join('');
  assert.doesNotThrow(() => compileCatalogBytes(sourceFilename));
});

test('source sanitizer uses the same taxonomy without rejecting the synthetic fixture', () => {
  assert.deepEqual(sourceContentIssues(JSON.stringify(sourceFixture)), []);
  assert.deepEqual(inspectJsonContent(JSON.stringify(sourceFixture), 'synthetic bundle'), []);
  const snippets = [
    ['{"user', 'Id":"fixture"}'].join(''),
    ['{"member', 'Id":"fixture"}'].join(''),
    ['{"api', 'Key":"fixture"}'].join(''),
    ['{"access', 'Key":"fixture"}'].join(''),
    ['{"authoriz', 'ation":"fixture"}'].join(''),
    ['{"endpoint":"https:/', '/www.c', 'money.tw/catalog"}'].join(''),
    ['{"host":"intern', 'al.c', 'money.tw"}'].join(''),
    ['{"path":"/', 'etc/private.conf"}'].join(''),
    ['{"path":"/', 'opt/private/tool"}'].join(''),
    ['{"path":"/', 'usr/loc', 'al/private/tool"}'].join(''),
    ['{"endpoint":"https:/', '/100.', '64.0.1/catalog"}'].join(''),
    ['{"endpoint":"https:/', '/198.', '18.0.1/catalog"}'].join(''),
    ['{"field":"', ['fd00', '', '1'].join(':'), '"}'].join(''),
    ['{"path":"/', 'Lib', 'rary/private/tool"}'].join(''),
  ];
  for (const snippet of snippets) assert.ok(sourceContentIssues(snippet).length > 0);

  for (const field of [
    ['acc', 'ount'].join(''),
    ['acc', 'ount', 'Name'].join(''),
    ['pro', 'file', 'Id'].join(''),
    ['pri', 'vate', 'Key'].join(''),
    ['cli', 'ent', 'Key'].join(''),
    ['o', 'auth', 'ClientId'].join(''),
    ['sign', 'ing', 'Key'].join(''),
    ['s', 'sh', 'Key'].join(''),
    ['key', 'Mater', 'ial'].join(''),
  ]) {
    assert.ok(inspectJsonContent(JSON.stringify({ [field]: 'fixture' }), 'serialized input').length > 0);
  }

  for (const address of [
    ['', '', ''].join(':'),
    ['ff02', '', '1'].join(':'),
    ['fec0', '', '1'].join(':'),
    ['2001', 'db8', '', '1'].join(':'),
  ]) {
    const snippet = ['{"field":"', address, '"}'].join('');
    assert.ok(sourceContentIssues(snippet).length > 0);
    assert.ok(inspectJsonContent(snippet, 'serialized input').length > 0);
  }

  for (const marker of privateKeyMarkers()) {
    assert.ok(sourceContentIssues(marker).includes('private-key material'));
    const serialized = clone(sourceFixture);
    serialized.routes[0].fixedParams[0].value = marker;
    assert.ok(inspectJsonContent(JSON.stringify(serialized), 'serialized source bundle').length > 0);
  }

  for (const systemPath of [
    ['C:\\', 'Program', 'Data\\private'].join(''),
    ['\\\\', 'server', '\\share'].join(''),
  ]) {
    const serialized = clone(sourceFixture);
    serialized.routes[0].fixedParams[0].value = systemPath;
    assert.ok(inspectJsonContent(JSON.stringify(serialized), 'serialized source bundle').length > 0);
  }
});

test('sanitized JSON inspection decodes escapes before applying compiler field and value semantics', () => {
  const unicodeEscape = (hex) => ['\\', `u${hex}`].join('');

  const company = clone(sourceFixture);
  const companyToken = ['c', 'money'].join('');
  company.baseUrl = ['https:/', '/www.', companyToken, '.tw/catalog'].join('');
  const escapedCompany = JSON.stringify(company).replace(
    companyToken,
    ['c', unicodeEscape('006d'), 'oney'].join(''),
  );

  const systemPath = clone(sourceFixture);
  const systemDirectory = ['Lib', 'rary'].join('');
  systemPath.routes[0].fixedParams[0].value = ['/', systemDirectory, '/', 'private/tool'].join('');
  const escapedSystemPath = JSON.stringify(systemPath).replace(
    systemDirectory,
    ['Lib', unicodeEscape('0072'), 'ary'].join(''),
  );

  const privateName = clone(sourceFixture);
  const privateNameValue = ['api', 'Key'].join('');
  privateName.routes[0].fixedParams[0].name = privateNameValue;
  const escapedPrivateName = JSON.stringify(privateName).replace(
    privateNameValue,
    ['api', unicodeEscape('004b'), 'ey'].join(''),
  );

  const privateQueryName = clone(sourceFixture);
  const privateQueryValue = ['member', 'Id'].join('');
  privateQueryName.routes[0].queryParams[0].queryName = privateQueryValue;
  const escapedPrivateQueryName = JSON.stringify(privateQueryName).replace(
    privateQueryValue,
    ['member', unicodeEscape('0049'), 'd'].join(''),
  );

  for (const raw of [
    escapedCompany,
    escapedSystemPath,
    escapedPrivateName,
    escapedPrivateQueryName,
  ]) {
    assert.ok(inspectJsonContent(raw, 'serialized source bundle').length > 0);
  }
});

test('strict input parsing rejects duplicate members before private values can be overwritten', () => {
  const fixtureText = `${JSON.stringify(sourceFixture, null, 2)}\n`;
  const safeUrl = sourceFixture.baseUrl;
  const privateUrl = ['https:/', '/www.c', 'money.tw/private'].join('');
  const privateQueryName = ['member', 'Id'].join('');
  const privateFixedName = ['api', 'Key'].join('');
  const cases = [
    fixtureText.replace(
      `"baseUrl": "${safeUrl}",`,
      `"baseUrl": "${privateUrl}",\n  "baseUrl": "${safeUrl}",`,
    ),
    fixtureText.replace(
      `"baseUrl": "${safeUrl}",`,
      `"base\\u0055rl": "${privateUrl}",\n  "baseUrl": "${safeUrl}",`,
    ),
    fixtureText.replace(
      '"id": "chipk.fixture.stock-overview",',
      '"id": "chipk.fixture.private",\n      "id": "chipk.fixture.stock-overview",',
    ),
    fixtureText.replace(
      '"queryName": "stockid"',
      `"queryName": "${privateQueryName}",\n          "queryName": "stockid"`,
    ),
    fixtureText.replace(
      '"name": "view",',
      `"name": "${privateFixedName}",\n        "name": "view",`,
    ),
  ];
  assert.equal(JSON.parse(cases[0]).baseUrl, safeUrl);

  for (const raw of cases) {
    assert.ok(inspectJsonContent(raw, 'serialized source bundle').some(
      (issue) => issue.includes('DUPLICATE_JSON_MEMBER'),
    ));
    const root = makeRoot();
    const input = path.join(root, 'source-bundle.json');
    const output = path.join(root, 'output');
    fs.mkdirSync(output, { mode: 0o700 });
    writeText(input, raw);
    try {
      assert.throws(() => loadSourceBundle(input), { code: 'DUPLICATE_JSON_MEMBER' });
      assert.throws(() => refreshCatalog({ inputPath: input, outputDirectory: output }), {
        code: 'DUPLICATE_JSON_MEMBER',
      });
      assert.deepEqual(fs.readdirSync(output), []);
    } finally {
      cleanup(root);
    }
  }
});

test('an existing target is never overwritten and leaves no staging files', () => {
  const { root, input, output } = setup();
  const target = path.join(output, TARGET_FILENAME);
  fs.writeFileSync(target, 'keep-existing\n', { flag: 'wx', mode: 0o600 });
  try {
    assert.throws(() => refreshCatalog({ inputPath: input, outputDirectory: output }), {
      code: 'OUTPUT_EXISTS',
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'keep-existing\n');
    assert.deepEqual(fs.readdirSync(output), [TARGET_FILENAME]);
  } finally {
    cleanup(root);
  }
});

test('atomic rename failure removes staging and lock artifacts', () => {
  const { root, input, output } = setup();
  const failingFs = Object.create(fs);
  failingFs.renameSync = () => {
    const error = new Error('injected rename failure');
    error.code = 'EIO';
    throw error;
  };
  try {
    assert.throws(() => refreshCatalog({
      inputPath: input,
      outputDirectory: output,
      fsImpl: failingFs,
    }), { code: 'CATALOG_WRITE_FAILED' });
    assert.deepEqual(fs.readdirSync(output), []);
  } finally {
    cleanup(root);
  }
});

test('a target created during publication is preserved instead of overwritten', () => {
  const { root, input, output } = setup();
  const target = path.join(output, TARGET_FILENAME);
  const racingFs = Object.create(fs);
  racingFs.linkSync = (source, destination) => {
    fs.writeFileSync(destination, 'concurrent-writer\n', { flag: 'wx', mode: 0o600 });
    return fs.linkSync(source, destination);
  };
  try {
    assert.throws(() => refreshCatalog({
      inputPath: input,
      outputDirectory: output,
      fsImpl: racingFs,
    }), { code: 'OUTPUT_EXISTS' });
    assert.equal(fs.readFileSync(target, 'utf8'), 'concurrent-writer\n');
    assert.deepEqual(fs.readdirSync(output), [TARGET_FILENAME]);
  } finally {
    cleanup(root);
  }
});

test('runtime source bundles are ignored while the tracked fixture stays synthetic', () => {
  const root = path.resolve(__dirname, '..');
  const ignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/);
  assert.ok(ignore.includes('runtime-data/'));
  assert.equal(sourceFixture.classification, 'synthetic');
  assert.match(sourceFixture.baseUrl, /^chipk-fixture:\/\//);
  assert.doesNotThrow(() => loadSourceBundle(
    path.join(root, 'fixtures', 'synthetic', 'source-bundle.json'),
    root,
  ));
  assert.throws(() => loadSourceBundle(path.join(root, 'package.json'), root), {
    code: 'SOURCE_TREE_BOUNDARY',
  });
  assert.throws(() => validateOutputDirectory(root, root), {
    code: 'SOURCE_TREE_BOUNDARY',
  });
});
