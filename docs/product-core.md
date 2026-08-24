# Product core and responsibility

Status: accepted product direction. Contract v1 remains unchanged for screenshots and raw
recordings. Contract v2 implements one reviewed ready-to-place screenshot-state vertical slice.

## Product core

> Turn a ChipK mobile-material intent into verified, reproducible, ready-to-place phone material
> while preserving the raw media, action semantics, and provenance needed to audit or regenerate it.

`Ready-to-place` means the phone-local presentation is complete enough for Marketing Video to use
without reinterpreting ChipK UI or rebuilding its focus and gesture logic. It does not mean that
the overall marketing scene, narrative, timeline, or final delivery has been approved.

## Product principles

1. **Correctness before artifacts.** Route selection, navigation, and material suitability are
   separate verdicts. A successful command or existing file is not proof that the material is
   correct.
2. **The interaction must be perceptible.** ChipK-specific focus, crop, zoom/pan, gesture emphasis,
   hold timing, and safe phone framing belong with the provider that understands the UI action.
3. **Prepared is the delivery; raw is the evidence.** The target bundle contains ready-to-place
   phone material plus raw media, actions, manifests, hashes, and provenance.
4. **Scale through versioned rules.** Reusable routes, recipes, presentation profiles, contracts,
   and regression tests replace one-off per-video scripts.
5. **Fail closed when evidence is incomplete.** Wrong pages, ambiguous readiness, unusable session
   state, unsupported presentation, and partial publication must not be reported as success.
6. **Keep runtime and account boundaries explicit.** Exact-device selection, authorization,
   session attestations, no-overwrite publication, and source-only Git rules remain invariants.

## Ownership

ChipK Simulator Capture owns:

- reviewed route selection, deterministic planning, exact-Simulator acquisition, and session gates;
- screenshot and interaction recording, readiness checks, and material evidence;
- ChipK-specific action semantics and phone-local presentation, including focus regions, gesture
  emphasis, zoom/pan intent, hold timing, and safe phone framing;
- rendering and encoding prepared phone clips, together with their raw inputs, actions,
  media metadata, hashes, and provenance;
- versioned catalogs, recipes, presentation profiles, the provider-side CLI/JSON contract, and
  provider tests.

Marketing Video owns:

- whether the provider is disabled, preferred, or required and what fallback is acceptable;
- the product-facing MaterialAcquisitionPort and its process/JSON adapter;
- Project, Revision, Asset, Run, Timeline, approval, and output ownership;
- selecting a supported presentation profile and ingesting the returned artifact;
- narrative structure, captions, music, scene-level composition, timeline placement, final render,
  delivery, and final-output QA for the complete marketing video.

Marketing Video places the prepared phone clip without modifying it. It may change only the
position and size of the clip's scene container; it must not reopen the clip or reimplement its
ChipK-specific crop, focus, gesture, or UI-state decisions.

## Feature gate

A Capture feature belongs in this product only when it materially improves at least one of these:

- the correctness of the real phone state;
- the viewer's ability to perceive the intended UI or interaction;
- reproducibility, throughput, or recovery of the material workflow;
- direct deliverability or auditability of the phone material.

Enabling infrastructure is in scope when it protects one of those outcomes. Project/timeline
management, generic editing, final-scene storytelling, and final delivery remain out of scope.

## Current v1 and v2 boundary

Request/Result v1 are closed and currently publish only screenshots or raw recordings with actions
and manifests. V1 does not advertise or imply prepared-video support, and its existing artifact
roles must not be overloaded with new semantics.

Contract v2 may advertise prepared mobile output only when it defines and verifies:

- versioned presentation-profile selection and capability discovery;
- prepared and raw artifact roles plus their provenance relationship;
- evidence and human-review semantics for presentation readiness;
- unsupported-profile, fallback, failure, and atomic-publication behavior;
- provider and Marketing Video compatibility tests across the version boundary.

The current v2 implementation passes these gates only for
`chipk.stock-main-force-portrait.v1`, route `chipk.stock.main-force`, and stock `3441`. It captures a
fresh screenshot, requires route-specific `主力買賣超` readiness plus usable `買賣家數差`
content, renders a five-second 30fps H.264 clip with no invented interactions, and atomically
publishes the prepared video, source PNG, capture manifest, presentation plan, and preparation
manifest. Other routes, stocks, profiles, or raw interaction recordings remain unsupported by v2
and fail closed. `touchPoint`, `touchPath`, and `zoomFocus` in v1 raw recordings are still not proof
that a prepared clip exists.
