# Experimental prepared mobile clip v0

## Decision boundary

This experiment tests one provider responsibility: turn an existing verified raw phone recording
into a phone-shaped H.264 clip that a consumer can place without understanding ChipK UI events.
The consumer chooses only `chipk.full-phone-portrait.v0`; the profile, normalized actions, and
observed timing determine the camera and interaction emphasis.

The experiment does not change Capture Request/Result v1 and does not freeze Contract v2. Its
output status remains `prepared_pending_human_review` until a person checks perceptibility and
readability.

## Inputs and fail-closed gates

The planner accepts the current recording bundle only when all of these facts are present:

- H.264 portrait raw video with positive, even dimensions and at most 30 seconds;
- actions schema v1 with `recording.encodedDurationMs` matching the media probe;
- `timing.observedComplete: true`, no missing event IDs, and passed observed offsets inside the raw
  timeline;
- at least one ordinary tap with `touchPoint`, one swipe with `touchPath`, one passed result
  assertion, and a final result hold with `zoomFocus`;
- every camera action has normalized `zoomFocus` that keeps its interaction geometry on-screen;
- a native long press is identified by `execution.longPress: true` and has a sufficiently long
  observed duration.

The planner never infers long press from an event ID or elapsed time. A tap whose observed duration
looks like a long press but lacks the explicit marker fails as `ambiguous_action_semantics`. This
keeps acquisition semantics from being silently rewritten during presentation.

## Deterministic plan and render

`src/prepared-plan.js` is a pure compiler. Given the same parsed actions, media facts, and profile,
it returns the same plan and canonical SHA-256 digest. The plan contains generated camera
keyframes, projected interaction geometry, swipe direction, result evidence, and the upstream
timing precision. It has no generated timestamp and no per-event-ID tuning.

`src/prepared-renderer.js` uses local FFmpeg only after the plan passes. The single v0 profile:

- preserves the source dimensions, aspect ratio, duration, and phone pixels;
- applies deterministic cosine camera moves from `zoomFocus`;
- shows a short expanding tap emphasis;
- keeps an explicit long-press emphasis visible for its observed duration;
- reveals ordered swipe trail samples from `touchPath`, preserving direction;
- keeps the asserted result region focused during the observed final hold;
- encodes H.264 with `libx264`, `yuv420p`, and no audio.

There are no captions, music, device shell, scene background, Marketing Video timeline layout, or
manual per-clip keyframes.

## Provenance and publication

Render requires the current recording manifest hashes, artifact names, recipe identity, and media
facts to match the raw video and actions. The three source artifacts and three prepared outputs
must share one bundle directory, so provenance uses only relative file names and raw/actions remain
beside the derived output. The renderer stages and probes the prepared video before atomically
publishing three new files:

- `prepared.mp4`;
- `prepared-plan.json`;
- `preparation-provenance.json`.

The provenance keeps raw/actions/recording-manifest hashes, the profile and plan hashes, output
media facts, FFmpeg identity, and the render-filter hash. It records that preparation itself did
not perform a fresh Simulator capture. Raw video and actions remain the reproducible inputs and
are never deleted or rewritten.

## Evidence and remaining gap

Prior ignored runtime evidence from one historical K-line recording showed that type-level camera
focus, normalized touch geometry, and observed timing can make a tap and result region visibly
different from raw footage. That evidence is not a fresh capture and does not prove cross-route
generality or viewer comprehension. Its hand-edited historical sidecar also lacks current required
fields, so this stricter planner rejects it rather than silently upgrading it.

The source tests prove deterministic planning, semantic fail-closed behavior, generated FFmpeg
filters, atomic publication, and provenance binding without requiring media or FFmpeg in CI. A
local synthetic render proves the command can produce and fully probe H.264, but human review of
real current recordings is still required for:

1. tap emphasis visibility without hiding the target;
2. sustained long-press meaning;
3. swipe path and direction perceptibility;
4. readable result hold;
5. camera targets and gesture geometry stay in-frame with no black bars or overlay obstruction.

Only after the same profile passes current recordings from multiple route families should its
fields become Contract v2 candidates.
