# Changelog

## 0.2.0 - 2026-08-21

First standalone release of the optional ChipK Simulator Capture provider.

- Own the versioned Capture Request/Result v1 CLI boundary, catalog, runtime adapter, and tests.
- Keep Marketing Video integration one-way through `chipk-capture capabilities/acquire` JSON.
- Add a screenshot-only conformance driver that uses the production CLI and contract with an
  injected synthetic runtime; it never calls Simulator, Keychain, or network services.
- Keep generated capture and conformance artifacts outside Git.

The `v0.2.0` tag is created only after provider preflight, the Marketing Video compatibility test,
and the provider-free Marketing Video regression all pass against the final commits.
