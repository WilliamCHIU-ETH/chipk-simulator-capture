# ChipK Simulator Capture

Standalone, optional ChipK material-acquisition provider for Marketing Video.

```text
Marketing Video MaterialAcquisitionPort
                 │ subprocess + JSON v1
                 ▼
        chipk-capture acquire
                 │
                 ├── reviewed route catalog → screenshot + manifest
                 └── recording recipe → raw MP4 + actions + manifest
```

The dependency is one-way: Marketing Video invokes the CLI and never imports provider internals;
this repository never imports Marketing Video. Marketing Video remains responsible for fallback,
asset ingestion, visual presentation, editing, and final delivery.

## Clean-clone validation

```bash
npm ci
npm run preflight
```

The tests exercise the full route, recipe, runtime orchestration, atomic-publication, and JSON
adapter logic with injected local fakes. They do not operate a Simulator or create tracked media.

## Versioned installation

Each release has one identity across `package.json`, `capabilities.toolVersion`, and its annotated
Git tag `v<version>`. A consumer pins the exact tag and resolved commit; a floating branch or an
unversioned executable found on `PATH` is not a reproducible installation.

After `v0.2.0` is published:

```bash
git clone --branch v0.2.0 --depth 1 \
  https://github.com/WilliamCHIU-ETH/chipk-simulator-capture.git
cd chipk-simulator-capture
npm ci
npm run preflight
./bin/chipk-capture.js capabilities --json
```

Marketing Video keeps the absolute executable path in local ignored configuration, not in Git:

```bash
export CHIPK_CAPTURE_BIN='/absolute/path/to/chipk-simulator-capture/bin/chipk-capture.js'
```

The provider stays an optional external executable. It is not copied into Marketing Video and is
not added to that application's package dependencies.

Before creating a release tag, run provider preflight, the cross-repository compatibility test,
and Marketing Video's provider-free regression against the final commits. Record the exact tag and
commit in the consumer compatibility lock only after all three pass.

## Cross-repository conformance

```bash
npm run test:conformance
```

`test/conformance-cli.js` is a test-only executable for the Marketing Video compatibility suite.
It calls the production CLI, validators, planner, and runtime adapter, but injects a deterministic
screenshot writer. Its PNG and manifest are created only in the caller-owned temporary output
directory. It never calls Simulator, Keychain, network, or paid services and is not a second
production Port.

## Stable CLI/JSON Port

```bash
node bin/chipk-capture.js capabilities --json
node bin/chipk-capture.js acquire --request /absolute/path/request.json --json
```

Installed package form:

```bash
chipk-capture capabilities --json
chipk-capture acquire --request /absolute/path/request.json --json
```

The request file must satisfy `contracts/capture-request.schema.json`. `outputDirectory` must be an
existing caller-owned absolute directory. The provider writes only the fixed no-overwrite bundle
inside that directory:

- screenshot: `screenshot.png`, `capture-manifest.json`;
- record: `raw.mp4`, `actions.json`, `recording-manifest.json`.

Result artifacts form a closed array. Every entry includes `role`, `kind`, POSIX `relativePath`,
`sha256`, and `mimeType`; image/video entries also include dimensions, codec when applicable, and
duration. No absolute artifact path crosses the Port.

Before an actual run, the provider process requires these provider-local values:

```bash
export CHIPK_SIMULATOR_UDID='<EXACT-UDID>'
export CHIPK_CAPTURE_AUTHORIZED=1
export CHIPK_DEDICATED_SIMULATOR_CONFIRMED=1
export CHIPK_VIP_SESSION_CONFIRMED=1
```

These are runtime selection and attestations, not credentials. Missing values return a typed
`human_action_required` result and publish nothing. `productionReady: true` in capabilities means
the reviewed catalog and runtime operations ship together; it does not claim that the current
device, App, session, OCR, or Maestro environment is ready.

## Provider-local tools

These commands remain available for operator planning and diagnostics; they are not the consumer
Port:

```bash
node scripts/simulator-capture.js catalog-check --json
node scripts/simulator-capture.js suggest --text '台積電的股票健檢與綜合評語' --json
node scripts/simulator-capture.js plan --route chipk.stock.health-check --stock-name 台積電 --mode test --json
node scripts/simulator-capture.js preflight --udid <EXACT-UDID> --json
node scripts/simulator-record.js recipe-check --json
node scripts/simulator-record.js plan --recipe renbao.kline-tab-switch-benchmark --json
```

Actual direct `capture` or `record` commands mutate Simulator state and require explicit user
authorization. See `.agents/skills/chipk-simulator-capture/SKILL.md` first.

## Source-only repository

Version code, architecture, rules, schemas, tests, sanitized deterministic fixtures, the reviewed
operational catalog, and recipes. Keep generated media, PDF, OCR, logs, manifests, action traces,
build output, credentials, session material, real persona data, private endpoints, and local
machine data out of Git.

Local files may live inside `.runtime/`, which is ignored. For optional persona tooling, copy
`config/personas.example.json` to `.runtime/personas.local.json` and fill it locally; never track
the local copy. Unknown generated types also start in `.runtime/` until clean-clone need and
sanitization are both established.

See `docs/architecture.md`, `docs/production-readiness.md`, and `AGENTS.md`.
