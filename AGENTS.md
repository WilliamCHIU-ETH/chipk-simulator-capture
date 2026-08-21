# ChipK Simulator Capture Agent Guide

This repository owns the source-only JSON and process boundary for optional ChipK material acquisition. Marketing Video owns fallback policy, Project asset import, presentation, and end-to-end delivery.

## Safety boundary

- The committed catalog and requests are synthetic fixtures. Never present them as product routes or runtime evidence.
- `productionReady` must remain derived from the shipped catalog and runtime adapter. Do not replace it with a manual constant or optimistic flag.
- A capture or record request must fail before filesystem output or runtime invocation unless a separately reviewed production catalog and runtime adapter are supplied and the caller explicitly authorizes that run.
- Never add internal Builder endpoints, company snapshots, persona identifiers, credential locators, credential readers, machine-specific absolute paths, or runtime capture artifacts.
- Never store or print passwords, tokens, cookies, MFA values, recovery codes, or session values.
- Tests and CI are provider-free and must not call Simulator, Keychain, network, or paid providers.

## Validation

```bash
npm ci
npm run preflight
```

This source-only implementation is intentionally not production-ready. A clean clone proves deterministic planning, contract validation, and fail-closed execution only.
