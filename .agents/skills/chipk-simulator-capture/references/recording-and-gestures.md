# Simulator recording and gesture contract

Use this contract only for an explicitly authorized interaction recording. Static PNG capture continues to use `scripts/simulator-capture.js`.

## Acquisition boundary

Under Contract v1, `scripts/simulator-record.js` owns deterministic acquisition:

`versioned recipe → exact Simulator → Maestro interaction → raw.mp4 + actions.json + recording-manifest.json`

It does not yet render zoom, pan, touch emphasis, or a prepared phone frame. The normalized
`touchPoint`, `touchPath`, `zoomFocus`, and observed timing fields in `actions.json` are
provider-owned preparation semantics for a future versioned presentation stage. They must not be
treated as a requirement for Marketing Video to reimplement ChipK-specific UI decisions. Music,
captions, narrative editing, scene-level composition, final render, and delivery remain Marketing
Video responsibilities. See `docs/product-core.md` for the accepted responsibility and v2 gate.

The first recipe is `renbao.kline-main-force-swipe`. It uses the catalog route `chipk.stock.kline` for `仁寶 (2324)` in Test Mode. Before recording, acquisition opens the exact catalog-resolved custom-scheme URL with `xcrun simctl openurl <exact-udid> <url>`. A separate Maestro preparation flow may conditionally tap the known iOS `打開` confirmation when it is visible, then verifies `K線`, `2324`, `仁寶`, the default `技術` group, and the absence of `使用 CMoney 帳號登入`. The Maestro preparation YAML must not contain `openLink`; this prevents Safari or stale-browser state from being mistaken for target navigation. Only after the local navigation process evidence and UI evidence pass does acquisition record the lower `主力` group tap, one native chart long press, one horizontal chart swipe, the strict result state, and presentation holds. The encoded raw clip must be 10–15 seconds.

The diagnostic recipe `renbao.kline-tab-switch-benchmark` deliberately has a narrower claim and a faster runner path. After the common exact-UDID `simctl openurl`, device/App preflight, and reviewed-layout probe, it executes exactly one `maestro test`. That Flow conditionally accepts the known `打開` prompt, verifies `K線`, `2324`, the default `技術` group, and login-submit absence, starts recording, taps the reviewed logical point `143,822` once, waits for animation to end, verifies `主力買賣超`, `買賣家數差`, `2324`, and `K線` while `籌碼集中` is absent, then stops recording. It does not run the separate Maestro preparation Flow or external `simctl recordVideo`. The target is about three seconds, while the accepted 1–60 second range keeps unexpected runner/device overhead available for diagnosis instead of deleting evidence. Its manifest remains `pending_human_review`: machine assertions establish the intended state, but they do not make the clip production-ready material.

## Commands

Validate all recipes and their catalog routes without touching a Simulator:

```bash
node scripts/simulator-record.js recipe-check --json
```

Inspect the resolved Deep Link, actions, reviewed coordinate/layout contract, evidence boundary, and capture gate:

```bash
node scripts/simulator-record.js plan \
  --recipe renbao.kline-main-force-swipe \
  --json
```

Plan the minimal diagnostic benchmark with:

```bash
node scripts/simulator-record.js plan \
  --recipe renbao.kline-tab-switch-benchmark \
  --json
```

After the exact device, installed QA App, and approved warm VIP session have been checked, record into three new paths:

```bash
mkdir -p .runtime/renbao-recording
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  node scripts/simulator-record.js record \
  --recipe renbao.kline-main-force-swipe \
  --runner maestro \
  --udid <EXACT-UDID> \
  --confirm-vip-session \
  --video "$PWD/.runtime/renbao-recording/raw.mp4" \
  --actions "$PWD/.runtime/renbao-recording/actions.json" \
  --manifest "$PWD/.runtime/renbao-recording/recording-manifest.json" \
  --json
```

`record` refuses aliases such as `booted`, missing VIP confirmation, unknown recipes or routes, non-Test-Mode recipes, unsafe routes, unsupported runners, forbidden action types, output paths in different directories, duplicate paths, and any existing output. It never fills login fields or executes recipe-provided shell or script content. A login page, missing default `技術` context, wrong device/layout, or missing result assertion fails without publishing `raw.mp4`, `actions.json`, or the manifest.

The three output paths must share one parent directory. Recording and JSON assembly happen in a task-created temporary directory under that parent, so they stay on one filesystem. The CLI probes, hashes, and fully prepares all three staged artifacts before publishing them with exclusive hard links. A publication error rolls back any artifact linked by that transaction; the CLI only removes its own temporary directory.

## Maestro 2.8 CLI contract

The local reviewed CLI is Maestro `2.8.0`:

- select one device with `--udid=<deviceId>` (the CLI also documents `--device`);
- write run artifacts with `--test-output-dir=<dir>`;
- artifact roots can be nested below that directory, so locate `manifest.json` recursively and resolve its `COMMAND_METADATA` entry rather than assuming `commands.json` is at the requested root;
- command metadata contains an epoch-millisecond `timestamp`, millisecond `duration`, status, sequence number, depth, and evaluated command.

The runner sets these environment values on every Maestro process:

```text
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
MAESTRO_CLI_NO_ANALYTICS=1
MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
```

The strict interaction recipe uses `xcrun simctl io <udid> recordVideo`; its recorder destination is always the staged path rather than the final path. Finalization is bounded: `SIGINT`, then `SIGTERM`, then `SIGKILL` if the child does not close. Only the normal SIGINT/zero-exit path with clean stderr is trusted; forced termination, reap timeout, suspicious stderr, or a bad exit rejects the run and publishes nothing.

The diagnostic benchmark instead uses Maestro `startRecording` and `stopRecording` inside its single Flow. The `startRecording` input is a validated relative stem without an extension. Acquisition recursively reads the successful Flow's artifact manifest and `commands.json`, requires one successful start and stop command, and resolves exactly one `START_SCREEN_RECORDING` MP4 from the successful start command metadata. Absolute paths, `..` traversal, symlink escape, missing/empty video, ambiguous artifacts, or failed/missing boundaries reject the run. The source MP4 is hard-linked—or exclusively copied when linking is unavailable—into the task-created staged raw path before normal ffprobe and atomic publication.

## Timing and presentation data

Target preparation runs before `recordVideo` in two evidence layers. Navigation is a local process event from zero-exit `xcrun simctl openurl <exact-udid> <catalog-url>` and records its timestamp, status, source, exact UDID, and URL. Readiness and login absence come only from Maestro command metadata after that navigation; they do not retroactively turn the local navigation event into Maestro evidence. A nonzero `openurl` fails closed before Maestro readiness, recording, or artifact publication. The combined pre-record evidence is saved in the manifest with absolute timestamps and `rawTimelineOffsets: not_applicable_pre_record`; none of it is presented as an event inside the raw clip.

`actions.json` deliberately separates:

- `planned`: recipe intent, reviewed execution geometry, gesture duration, touch geometry, and zoom focus; and
- `observed`: only events backed by Maestro `commands.json` timestamps or by locally executed recipe holds.

For the strict recipe, the process clock begins at `recording.startedAt`, the successful `simctl recordVideo` process-spawn boundary rather than a measured first video frame. For the diagnostic recipe, it begins at the successful Maestro `startRecording` command-completion boundary; the stop request is the successful `stopRecording` command-start boundary and finalize is that command's completion. In both paths, acquisition estimates `estimatedEncoderStartOffsetMs` as `recorder stop-request elapsed - ffprobe encoded duration`, clamped at zero. `startedOffsetMs` and `completedOffsetMs` are process offsets mapped by that estimate; the original `processStartedOffsetMs` and `processCompletedOffsetMs` remain beside them. The manifest records the method, value, end-alignment assumption, and finalize duration in `recording.timelineCalibration`. Maestro timestamps describe command execution, not the exact physical touch sample or encoded video frame. Preserve `timingSource`, `precision`, calibration, and `anchorSemantics` when generating zooms; do not upgrade them to frame-accurate evidence. Every mapped event must still fit the ffprobe duration plus the unchanged explicit 1000 ms tolerance; calibration is not permission to widen that tolerance.

If a runner adapter cannot report a step timestamp and no matching Maestro command metadata exists, the step remains only in `planned`. Do not synthesize an observed timestamp from the recipe duration.

Recipe and presentation geometry stays normalized to the full portrait screen (`0..1`). The lower K-line `主力` tab is not uniquely addressable: another visible `主力` label can exist higher on the page. V1 therefore executes exactly one reviewed coordinate tap at normalized `x=0.3557, y=0.9405`; it never attempts a selector and coordinate sequentially. The reviewed layout records two distinct coordinate spaces: screenshot pixels are 1206×2622, while Maestro hierarchy and tap interaction use 402×874 logical points. Before tapping, a discarded screenshot probe and Simulator metadata must still match iPhone 17 Pro, iOS 26.5, portrait, 1206×2622. Acquisition compiles the normalized point with the interaction dimensions to integer logical point `143,822`; it must never derive Maestro coordinates from screenshot pixels.

After the lower-tab tap and its settle wait, V1 uses Maestro's native `longPressOn` at logical point `330,430`. On the reviewed iOS runner this is a fixed native long press of roughly three seconds; the recipe does not claim a configurable 700 ms touch. It then swipes from logical `330,430` to `110,430` for 900 ms. Runtime coordinates are compiled only from the exact 402×874 interaction space—never from 1206×2622 screenshot pixels and never as decimal percentages. The corresponding normalized `touchPoint`, `touchPath`, and `zoomFocus` remain presentation metadata for later zoom and touch effects.

The strict result assertion requires `主力買賣超`, `買賣家數差`, `2324`, and `K線` to be visible while `籌碼集中` is absent. The adjacent `籌碼日報` tab label is expected to remain visible even when K-line is selected, so it must not be used as an absence assertion. `K線` visibility confirms that the expected tab label remains on screen; because the source UI has no reviewed accessibility selected-state contract, it does not independently prove AX selection state. The combined positive and negative assertions reduce false passes on an upper main-force tab or a different weekly/monthly/customized group. Acquisition executes the tap, chart long-press, swipe, and result assertion in one Maestro flow so CLI startup is not recorded between gestures; an adaptive final hold fills toward the 12-second target. Maestro `commands.json` supplies the observed native-long-press duration (normally about three seconds), and the timeline never replaces it with an invented recipe duration. The pre-record readiness already establishes the initial screen, and ffprobe still enforces the 10–15 second encoded range.

## Output evidence

The recording manifest keeps these claims separate:

- `route`: catalog route, resolved URL, and parameters;
- `navigation`: whether the pre-record route/readiness/login-absence events have observed passing evidence;
- `material`: what the clip is intended to support, what it does not prove, Test Mode status, and whether human review is still pending.

`ffprobe` must verify one H.264 video stream with positive duration and dimensions before success. The manifest stores codec, duration, dimensions, App bundle/version/build, exact device, recipe hash, event trace, and SHA-256 hashes for both `raw.mp4` and `actions.json`.

The manifest also stores process-wall-clock `pipelineTimings`. The strict path records `runner_prepare`, `device_preflight`, `route_navigation`, `target_readiness`, `layout_probe`, `recorder_start`, `interaction`, `recorder_finalize`, `video_probe`, and `artifact_preparation`. The diagnostic path records `runner_prepare`, `device_preflight`, `route_navigation`, `layout_probe`, one `single_flow`, `video_probe`, and `artifact_preparation`; it must not imply separate readiness, recorder, or interaction processes that did not occur. These durations diagnose orchestration overhead; they use a clock independent from the raw-video offset anchor and must never be interpreted as frame timing. On failure, completed and failed stages are attached to structured error details whenever execution reached the timing tracker, while partial recording artifacts remain unpublished.
