---
name: chipk-simulator-capture
description: "Turn Traditional Chinese marketing copy into audited ChipK iOS Simulator route plans and, when explicitly authorized, verified screenshots. Use for 籌碼K線 Deep Link selection, live or historical-script test mode, QA Simulator preflight, VIP-screen capture, catalog refresh, or screenshot evidence review."
---

# ChipK Simulator Capture

Create reproducible phone-screen material through this chain:

`copy → ranked route IDs → explicit plan → exact Simulator → route/content checks → PNG or raw interaction recording + evidence manifests`

This skill owns screen acquisition. It does not own final zoom, pan, device framing, B-roll editing, or video assembly.

## Start here

1. Work from the repository root that contains `scripts/simulator-capture.js`.
2. Choose a mode. If the user does not name one, use `live`.
3. Run `catalog-check` before planning or capture.
4. Use only route IDs and parameters present in `config/simulator-capture.catalog.json`. Never invent a Deep Link.
5. Keep selection, navigation, and screenshot suitability as three separate verdicts.

Marketing Video uses only the stable process boundary:

```bash
chipk-capture capabilities --json
chipk-capture acquire --request <absolute-json-file> --json
```

The helper commands below are provider-local planning and diagnostic tools, not an alternative
consumer Port.

Read [modes-and-evidence.md](references/modes-and-evidence.md) when deciding mode, readiness, or success. Read [source-contract.md](references/source-contract.md) when refreshing sources or resolving a Sheet/Builder/iOS conflict. Read [ios-runtime-contract.md](references/ios-runtime-contract.md) before build, install, or Simulator work. Read [session-and-login.md](references/session-and-login.md) before checking or restoring an approved QA session. Read [recording-and-gestures.md](references/recording-and-gestures.md) only when the request includes Simulator gestures or raw video recording.

## Modes

- `live` is the production default. The copy is for today, and time-sensitive claims must not visibly conflict with the current app screen. Stop for human review when the screenshot cannot support the claim.
- `test` exercises routing and automation with the approved dedicated test persona on its dedicated Simulator. Within that boundary, default to full product exploration and reversible account-local operation: open reviewed Deep Links, accept the known iOS ChipK open-confirmation, foreground the App, inspect unfamiliar product UI, switch tabs, open details, scroll, swipe, go back, capture screenshots, and record interactions. Historical copy may use the current screen; do not fail only because dates, prices, news, rankings, or campaign content differ. Still require the intended feature/page and a usable output.

Do not silently downgrade `live` to `test`.

## Environment handoff

- Before actual Simulator work, determine whether the device, App, and approved session are usable enough for the requested capture. Do not equate a successful tool preflight with a verified login or VIP session.
- When an observed environment problem blocks capture, you may infer likely causes and label them as inference. Never turn an inference into permission to enter credentials, handle MFA/CAPTCHA, change authentication/domain/security settings, operate a non-test account, or bypass access controls. The known iOS prompt `要在籌碼K線中打開此網頁嗎？` after a reviewed ChipK Deep Link is ordinary navigation in `test`; tap `打開` automatically. Inspect other product UI before classifying it as a gate.
- Once the user authorizes capture on one exact approved dedicated test Simulator, that authorization also covers read-only diagnostic screenshots and local OCR of its current product screen after a navigation or readiness failure. Keep those diagnostics in ignored `.runtime/`, never publish them, and do not ask for a second permission merely because the approved session is logged in. This does not authorize reading or reporting secure text-field values, entering credentials, or proceeding through login, MFA, or CAPTCHA; stop if one of those screens is encountered.
- An environment gate pauses only the Simulator-dependent branch, but an actionable human gate ends the current turn. Stop only when the workflow requires login/unlock/credentials/MFA/CAPTCHA, a domain or security change, real money/trading/purchase, an external message or public post, action on a non-test account or another person, or irreversible deletion/escape from the Simulator and test-persona boundary. Then stop active tools and subagents, send a `final` response, and wait for an explicit reply such as `登入好了`. Route selection can remain a decision/evidence gate, but ordinary iOS open confirmation and reversible test-account UI are not permission gates.
- Before an actionable human gate is reached, independent route planning, copy analysis, or review of existing material may continue when useful. After the gate is reached, defer any remaining independent work to the resumed turn. If existing material is reused, label it as prior evidence rather than a fresh capture from the current run.
- The final response must state whether a fresh capture occurred, what completed, what was not executed and why, any reused artifact and its provenance, the exact human action needed, and where the workflow can resume. Do not leave this information only in commentary.

## Workflow

### 1. Validate and rank

```bash
node scripts/simulator-capture.js catalog-check
node scripts/simulator-capture.js suggest --text '台積電的股票健檢與綜合評語' --json
```

Treat `suggest` as retrieval, not a final decision. Report the top candidates, matched terms, resolved and missing parameters, machine-readable gates, and uncertainty. The versioned stock directory may resolve an exact canonical name such as `台積電` to `2330`; never fuzzy-match, abbreviate, or guess a stock. Ask for human choice when multiple candidates or stocks reasonably fit, a required input remains missing, or the copy requires a subjective visual.

### 2. Produce a side-effect-free plan

```bash
node scripts/simulator-capture.js plan \
  --route chipk.stock.health-check \
  --stock-name 台積電 \
  --mode test \
  --json
```

Confirm the resolved route ID, required parameters, custom-scheme URL, expected texts, and mode. Planning must not call `simctl` or write an output file.

For a planning-only request, return at least:

- selected mode and script-date status;
- ranked route IDs, match rationale, and route-choice confidence;
- resolved or missing parameters and unresolved gates;
- resolved URL for a ready plan;
- readiness texts versus optional content texts;
- historical mismatches tolerated by `test`, if any;
- stop reason and next human/capture gate.

### 3. Preflight one exact Simulator

List devices first when the user has not supplied a UDID:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcrun simctl list devices available
```

Then use one exact booted UDID:

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  node scripts/simulator-capture.js preflight --udid <UDID> --json
```

Do not use the ambiguous `booted` alias. Require the QA app bundle `CMoney.Chipk`. Use a dedicated Simulator because installing the QA build can replace another app with the same bundle ID. This preflight verifies the device, installed App metadata, and OCR tooling; it does not verify whether the App is already running, logged in, or entitled as VIP.

### 4. Verify or recover the approved session

The expected persona role is VIP. Actual identifiers and secure-store locators belong only in
ignored `.runtime/personas.local.json`; Git contains only `config/personas.example.json` and
`contracts/personas.schema.json`. Never place a real login identifier, password, token, cookie,
recovery code, locator, or
session value in source, stdout, a manifest, or shell history. The `--confirm-vip-session` capture
flag and `CHIPK_VIP_SESSION_CONFIRMED=1` stable adapter setting are caller attestations, not machine
login checks.

If the approved session is already active, do not log in again. A cold App launch invokes the App's native `autoLogin`; this is different from an agent entering credentials. The currently verified workflow does not automate credential entry. For an allowlisted read-only Deep Link, the target page itself is sufficient session evidence when the intended page/stock texts are visible and the login submit control is absent; do not require a particular home screen first. If native auto-login does not establish the approved session or the Deep Link lands on login, pause session recovery and capture, report likely causes as inference, and hand off the login step to the user according to **Environment handoff**.

A locked page can prove that the route was reached, but it is not a usable VIP screenshot. Record these separately:

- `route_reached`
- `content_access: unlocked | locked | unknown`
- `capture_usable`

### 5. Capture only when authorized

Actual capture opens the app and changes Simulator state. Require an explicit new output path and manifest path; never overwrite either.

```bash
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  node scripts/simulator-capture.js capture \
  --route chipk.stock.health-check \
  --stock-id 2330 \
  --stock-name 台積電 \
  --mode test \
  --udid <UDID> \
  --confirm-vip-session \
  --output "$PWD/.runtime/direct/chipk-health-check.png" \
  --manifest "$PWD/.runtime/direct/chipk-health-check.json"
```

Use OCR polling/readiness checks, not a fixed sleep. In `test`, automatically resolve the known ChipK open-confirmation and continue through ordinary reversible account-local UI. An unresolved timeout, login/MFA/CAPTCHA page, external Safari page, credential/security prompt, missing route text, or wrong stock must block that capture visibly. A generic timeout is not proof of a specific login cause; inspect the available evidence and report uncertainty. Do not accept a PNG merely because a file exists.

### 6. Report three verdicts

Always return:

1. `route_selection`: why the chosen catalog route supports the copy.
2. `navigation`: whether the app reached the intended page and stock.
3. `material`: whether the captured screen actually supports the copy and is clean enough to use.

For `live`, include visible time-sensitive conflicts. For `test`, label those conflicts tolerated by the mode.

When any Simulator-dependent branch is skipped, partial, or replaced with prior material, also report the environment handoff required above. The three verdicts describe each material candidate; they do not imply that the current environment was ready or that a fresh capture occurred.

## Source refresh

Raw refresh inputs and generated candidates stay in ignored `.runtime/`; never mirror a Sheet,
Builder response, iOS checkout, internal endpoint, or machine path into Git. The provider-free
compiler accepts only a reviewed, schema-closed source bundle:

```bash
mkdir -p .runtime/catalog-refresh
node bin/chipk-refresh-catalog.js \
  --input .runtime/source-bundle.json \
  --output .runtime/catalog-refresh
```

Compilation produces a candidate and digest, not automatic approval. Promote only the minimal
sanitized route/rule changes into `config/simulator-capture.catalog.json`, preserve known conflicts,
and run the full preflight. The operational catalog remains the single canonical writer.

Use `references/golden-cases.json` as the minimum regression set when changing intent terms, ranking, route IDs, or mode behavior.

## Hard boundaries

- A successful `chipk://` route does not prove the HTTPS Universal Link or AASA configuration works.
- In `test` with the approved dedicated persona and Simulator, full product exploration and reversible account-local operation are authorized by default, including reviewed Deep Links, the known iOS `打開` confirmation, App foreground switching, unfamiliar product pages, tabs, scrolling, swiping, back navigation, product details, screenshots, and recording. A recipe may specify the intended path, but unfamiliarity alone is not a permission gate.
- Stop only before real money/trading/purchase; affecting a non-test account or another person; sending an external message or publishing content; handling credentials, MFA, CAPTCHA, domain, or security settings; or irreversible deletion / action that may escape the dedicated Simulator and test-persona boundary.
- Do not patch login state, Remote Config, entitlements, or app code to force a screenshot.
- Only the sanitized persona example and schema may be versioned. Actual persona metadata,
  credentials, locators, and runtime session material remain local and ignored.
- Do not claim dynamic prices, rankings, news, campaign cards, VIP access, or floating marketing video are deterministic.
- Do not run the legacy `scripts/shot.js` for this workflow; it selects an arbitrary booted device and uses fixed timing/cropping.
- Do not build or install unless the user requested it. If a build is required, follow the QA contract in `ios-runtime-contract.md` and do not run the destructive `QA.sh`.
