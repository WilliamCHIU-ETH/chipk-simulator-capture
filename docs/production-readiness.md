# Production readiness

This checkout ships both reviewed operational catalog data and screenshot/record runtime logic, so
`capabilities --json` reports `productionReady: true` with `screenshot` and `record` operations.

That flag describes build capability, not current environment state. Each acquisition still
verifies provider-local run attestations, an exact booted Simulator, installed App metadata, OCR,
route readiness, approved session evidence, recording runner evidence, output freshness, hashes,
and media properties as applicable.

## What clean-clone CI proves

- request/result schema behavior and stable stdout/exit semantics;
- reviewed route and recipe invariants;
- exact-device and session gates through injected runtime fakes;
- screenshot/record orchestration and no-overwrite atomic publication;
- relative artifact descriptors with SHA-256 and media metadata;
- source-only tracked-path and content policy.

CI does not prove that a current Simulator is booted, an approved session is active, dynamic App
content matches marketing copy, or a fresh output is editorially suitable. Those remain per-run
evidence.

## Runtime acceptance

Before archiving the old app source, validate one standalone provider run and one Marketing Video
adapter run against the same provider contract. Keep the app copy recoverable until both pass.
Actual Simulator mutation is never part of `npm run preflight` and requires explicit user
authorization.
