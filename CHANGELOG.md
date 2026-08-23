# Changelog

## 0.2.1 - 2026-08-23

P0 navigation reliability and evidence-boundary release for the standalone provider.

- Keep the stable Contract v1 process boundary unchanged: `capabilities` and `acquire` publish
  screenshots or raw recordings with their evidence states and actions. They do not advertise or
  return prepared-video artifacts, and a completed capture does not imply editorial approval.
- Mark the Featured main-force route as requiring root navigation, omit the inherited
  `noReloadApp` query for that route, and carry the decision into plans and recording provenance.
  Release still requires an exact-commit P0 root-navigation regression attestation.
- Bound OCR readiness matching to geometry-valid, contiguous same-row word clusters and a
  maximum three-line, vertically adjacent and column-aligned PSM11 fallback. OCR remains text
  evidence, not proof of selected state or unique route identity.
- Add deterministic source-coverage reporting that separates catalog, readiness-text, content,
  interaction-recipe, explicit Accessibility-identifier, and runtime-verification claims.
  Runtime Accessibility remains `unknown_not_observed`; the source report does not claim that
  Accessibility is unavailable or runtime-verified.
- Add an exact-commit `v0.2.1` checklist that checks release identity, source-truth shape, and
  attestation completeness while retaining `releaseDecision: human_required`. It does not run or
  authenticate the attested checks and cannot authorize a tag or release.
- Document the accepted provider responsibility for future ready-to-place phone material and ship
  the provider-local experimental `chipk.full-phone-portrait.v0` planner/renderer. This profile is
  not Contract v2, is not exposed through Contract v1, remains
  `prepared_pending_human_review`, and still requires current real-recording and perceptibility
  evidence before contract promotion.

## 0.2.0 - 2026-08-21

First standalone release of the optional ChipK Simulator Capture provider.

- Own the versioned Capture Request/Result v1 CLI boundary, catalog, runtime adapter, and tests.
- Keep Marketing Video integration one-way through `chipk-capture capabilities/acquire` JSON.
- Add a screenshot-only conformance driver that uses the production CLI and contract with an
  injected synthetic runtime; it never calls Simulator, Keychain, or network services.
- Keep generated capture and conformance artifacts outside Git.

The `v0.2.0` tag is created only after provider preflight, the Marketing Video compatibility test,
and the provider-free Marketing Video regression all pass against the final commits.
