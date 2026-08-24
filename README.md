# ChipK Simulator Capture

Standalone, optional ChipK material-acquisition provider for Marketing Video.

```text
Marketing Video MaterialAcquisitionPort
                 │ subprocess + versioned JSON
                 ▼
        chipk-capture acquire
                 │
                 ├── v1 screenshot → PNG + manifest
                 ├── v1 recording recipe → raw MP4 + actions + manifest
                 └── v2 prepared-video → fresh PNG + ready-to-place MP4 + provenance
```

The dependency is one-way: Marketing Video invokes the CLI and never imports provider internals;
this repository never imports Marketing Video. Capture owns ChipK-specific acquisition, evidence,
and phone-material preparation. Marketing Video owns fallback, Project/Revision/Asset/Timeline,
scene-level composition, final rendering, and delivery.

The default target for a video workflow is a verified, ready-to-place mobile bundle. Contract v1
remains unchanged for screenshot and raw-recording callers. Contract v2 adds one fail-closed
vertical slice: `chipk.stock.main-force` + stock `3441` + profile
`chipk.stock-main-force-portrait.v1`. It captures a fresh screenshot and publishes a five-artifact
prepared bundle only after route, stock, content, render, and provenance checks pass. See
`docs/product-core.md` for the responsibility boundary.

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
commit in the consumer compatibility lock only after all three pass. The proposed `v0.2.1` has an
exact-commit checklist for P0 root-navigation regression, source coverage truth, release identity,
and final-commit convergence; see `docs/release-v0.2.1-checklist.md`. The tool checks attestation
completeness but does not authenticate references, execute the claimed commands, or authorize a
tag/release. Follow-up OCR, prepared-clip, and Accessibility/latency evidence are not `v0.2.1`
checklist requirements. This does not change the published scope of `v0.2.0`.

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

The request file must satisfy the schema advertised for its contract version. `outputDirectory`
must be an existing caller-owned absolute directory. The provider writes only a fixed no-overwrite
bundle inside that directory:

- screenshot: `screenshot.png`, `capture-manifest.json`;
- record: `raw.mp4`, `actions.json`, `recording-manifest.json`.
- prepared-video v2: atomic `ready-to-place/` directory containing `prepared.mp4`,
  `screenshot.png`, `capture-manifest.json`, `presentation-plan.json`, and
  `preparation-manifest.json`.

For a Marketing Video workflow, ready-to-place is the default delivery target. The stable consumer
must discover Contract v2 through `capabilities`, select its advertised presentation profile, and
call the canonical `prepared-video` Port. Provider-local direct helpers plus manual asset ingest are
diagnostics, not a valid replacement for this contract. An unsupported profile, route, stock,
readiness check, or partial bundle fails closed; it never silently falls back to a raw screenshot.

The first v2 request shape is:

```json
{
  "contractVersion": 2,
  "requestId": "example-ready-to-place-001",
  "operation": "prepared-video",
  "mode": "test",
  "target": {
    "routeId": "chipk.stock.main-force",
    "stockId": "3441"
  },
  "presentation": {
    "profileId": "chipk.stock-main-force-portrait.v1"
  },
  "outputDirectory": "/absolute/caller-owned/runtime-directory"
}
```

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
npm run --silent coverage:source
npm run --silent release:gate:v0.2.1
```

The coverage and release commands are provider-local source diagnostics. They do not add commands
to the canonical `chipk-capture capabilities/acquire` Port. See `docs/source-coverage.md` for the
route-level evidence boundary.

Any actual v1 or v2 acquisition mutates Simulator state and requires explicit authorization in the
current request. The v2 default for video workflows does not bypass that gate. See
`.agents/skills/chipk-simulator-capture/SKILL.md` first.

## Experimental prepared mobile clip v0

The provider-local experiment can turn an already-published raw recording bundle into a
full-phone H.264 clip whose camera and interaction emphasis are derived from normalized actions:

```bash
node scripts/prepare-mobile-clip.js profile-check --json
node scripts/prepare-mobile-clip.js plan \
  --raw .runtime/example/raw.mp4 \
  --actions .runtime/example/actions.json \
  --profile chipk.full-phone-portrait.v0 \
  --json
node scripts/prepare-mobile-clip.js render \
  --raw .runtime/example/raw.mp4 \
  --actions .runtime/example/actions.json \
  --recording-manifest .runtime/example/recording-manifest.json \
  --profile chipk.full-phone-portrait.v0 \
  --video .runtime/example/prepared.mp4 \
  --plan .runtime/example/prepared-plan.json \
  --manifest .runtime/example/preparation-provenance.json \
  --json
```

This raw-recording experiment is not the stable screenshot-state v2 profile. It does not touch a
Simulator or network, and it fails closed when current actions lack passed observed timing,
normalized gesture geometry, an explicit long-press marker, result assertion, or result hold.
Generated media, plans, and provenance stay under ignored `.runtime/`. See
`docs/prepared-mobile-clip-v0.md`.

## Source-only repository

Version code, architecture, rules, schemas, tests, sanitized deterministic fixtures, the reviewed
operational catalog, and recipes. Keep generated media, PDF, OCR, logs, manifests, action traces,
build output, credentials, session material, real persona data, private endpoints, and local
machine data out of Git.

Local files may live inside `.runtime/`, which is ignored. For optional persona tooling, copy
`config/personas.example.json` to `.runtime/personas.local.json` and fill it locally; never track
the local copy. Unknown generated types also start in `.runtime/` until clean-clone need and
sanitization are both established.

See `docs/product-core.md`, `docs/architecture.md`, `docs/production-readiness.md`, and `AGENTS.md`.
