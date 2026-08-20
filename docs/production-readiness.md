# Production readiness

The shipped repository is deliberately **not production-ready**.

`capabilities.productionReady` is computed from build inputs, not set by a CLI flag. The synthetic catalog, empty build-owned digest trust store, and missing runtime adapter independently keep the value false.

## Required external review

- Supply a minimal production catalog through a separate approved delivery mechanism.
- Prove its source classification and SHA-256 digest without committing raw company snapshots. The digest is computed from recursively key-sorted catalog JSON with the top-level `sourceDigest` field omitted.
- Add only that reviewed digest to `src/trust-store.js` through code review; a catalog-provided checksum is integrity evidence, not approval.
- Implement and review a runtime adapter outside this source-only change.
- Verify one dedicated Simulator, application/session boundary, overwrite protection, and immutable artifacts.
- Run a fresh authorized end-to-end screenshot and recording acceptance test.

Until every item is complete, consumers must use fallback and must not present a successful plan as capture evidence.

## Catalog refresh boundary

`chipk-refresh-catalog` compiles an explicit, schema-closed source bundle into deterministic catalog bytes inside an explicit output directory. It does not discover sibling repositories, fetch endpoints, read credentials, invoke a runtime adapter, or approve the resulting digest. Real source bundles and generated catalogs are runtime inputs and must remain in ignored `runtime-data/` or external controlled storage.

The compiler rejects duplicate JSON members before parsing, company or internal endpoints, non-public addresses, system or machine paths, persona and identity fields, credential locators, duplicate route or parameter identities, symbolic-link boundaries, path traversal, and existing targets. Its output may be reviewed in a later change, but catalog compilation alone leaves `productionReady` false because `src/trust-store.js` remains build-owned and empty.
