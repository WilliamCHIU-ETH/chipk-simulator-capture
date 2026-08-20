# ChipK Simulator Capture

Source-only implementation of an optional, independently versioned ChipK material-acquisition provider.

```text
Marketing Video
      │ MaterialAcquisitionPort
      ▼
ChipK CLI adapter
      │ versioned JSON / process boundary
      ▼
catalog + planner + production gate
      │
      └── runtime adapter (not shipped)
```

The repository intentionally ships only a synthetic catalog and no Simulator runtime adapter. A clean clone can validate requests, produce deterministic plans, and prove that screenshot or recording execution fails before any output or runtime invocation.

Marketing Video must continue end-to-end when this provider is unavailable or reports `productionReady: false`. Fallback selection remains outside this repository.

## Commands

```bash
npm ci
npm run preflight
node bin/chipk-capture.js --version
node bin/chipk-capture.js capabilities --json
node bin/chipk-capture.js plan --request fixtures/synthetic/request.json --json
mkdir -p runtime-data/catalog-refresh
node bin/chipk-refresh-catalog.js \
  --input fixtures/synthetic/source-bundle.json \
  --output runtime-data/catalog-refresh
```

`capture` and `record` share the same request contract, but the shipped build rejects them with `PRODUCTION_NOT_READY`. It does not create an output directory or call a runtime tool.

The refresh command is a provider-free compiler. It requires one explicit regular input file and one explicit, pre-existing, current-user-owned output directory. It refuses symbolic links, parent traversal, duplicate JSON members, unknown fields, company or internal endpoints, identity or credential fields, system paths, non-public addresses, an existing `catalog.json`, and any output it cannot publish atomically. The real source bundle and generated catalog belong only in ignored `runtime-data/` or external controlled storage; the repository tracks only the schema, compiler, synthetic fixture, and tests.

The generated digest is integrity evidence, not approval. Catalog refresh does not modify the build-owned trust store and therefore cannot make this source-only build production-ready.

## Evidence boundary

- Confirmed by tests: contract validation, deterministic URL planning, immutable fixed parameters, explicit production gate, provider-free catalog compilation, atomic no-overwrite publication, and fail-closed private-input scanning.
- Not confirmed: real product routes, a usable Simulator session, screenshot/recording output, recipe parity, or production readiness.
- Excluded from Git: internal source snapshots, credentials and locators, machine paths, recordings, screenshots, manifests, and runtime data.

See [docs/architecture.md](docs/architecture.md) and [docs/production-readiness.md](docs/production-readiness.md).
