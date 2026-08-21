# Modes and evidence

## The three checks

Treat these as independent:

1. **Selection** — the copy maps to the best available route in the catalog.
2. **Navigation** — the app reaches the intended product page, stock, and tab.
3. **Material** — the visible screen supports the copy and is suitable for the edit.

One success does not imply the next. A correct Deep Link can land on a login wall. A correct page can still be loading, locked, covered by a prompt, or visually unrelated to the sentence.

## Live mode

Use for current production work.

- Input copy is treated as current.
- Dynamic claims such as price, date, ranking, news, event state, or recommendation must be visually compatible with the current screen.
- If the screen is directionally relevant but conflicts with the claim, return `needs_human_review`; do not quietly publish the material.
- Save the capture timestamp and catalog version in the manifest.

## Test mode

Use for historical scripts and automation development.

- Current app data may illustrate an older script.
- Ignore mismatch in dates, prices, rankings, news, and other time-varying content when the intended feature and interaction are correct.
- With the approved dedicated test persona on its dedicated Simulator, default to full product exploration and reversible account-local operation. This includes reviewed Deep Links, automatically accepting the known ChipK iOS `打開` confirmation, foreground switching, unfamiliar product UI, tabs/details/back, scroll/swipe, screenshots, and recording. Do not relax route identity, required parameters, login/VIP evidence, overwrite protection, or the external-impact boundary.
- Mark tolerated mismatches in the result so a test artifact cannot be mistaken for live evidence.

## Readiness

Prefer stable, meaningful text over elapsed time. A useful readiness result records:

- intended stock identity when applicable;
- intended tab or page title;
- at least one content-level phrase where reliable;
- whether content is unlocked;
- absence of blocking login/MFA/CAPTCHA, external Safari, credential/security prompt, and obvious loading state. The known ChipK iOS open-confirmation is automatable navigation, not a blocking permission prompt.

OCR can be imperfect. Use tolerant text matching, retain the OCR evidence, and use human review when the only miss may be OCR noise. Do not weaken all checks to make one flaky screen pass.

For `chipk.stock.health-check`, the current reviewed evidence is:

- stock: `2330` / `台積電`;
- tab: `健檢`;
- content candidates: `綜合評語`, `交易屬性健診`;
- optional lower sections: `技術趨勢`, `大股東籌碼`, `法人動態`, `股價評估`, `公司體質`.

The floating marketing video is observational only: record `visible`, `not_visible`, or `unknown`. It depends on remote campaign rules and must not be a required assertion.

## Human gates

A human gate pauses only the route-selection, session-recovery, or capture branch that depends on the missing decision or access. Once it requires a concrete user action, stop active tools and subagents, end the current turn with the handoff in `final`, and wait for the user's explicit reply. Do not continue background work or poll after requesting intervention in commentary; the user may not receive a notification until the turn ends. Independent planning, copy analysis, and review of existing material may continue only before the actionable gate is reached or after the user resumes the task. Never present reused material as a fresh capture, and always disclose the blocked branch, likely cause versus confirmed evidence, required human action, and resume point in the final response.

Interaction permission pauses only when the next action would:

- involve real money, trading, purchase, or payment;
- affect a non-test account or another person;
- send an external message or publish content;
- handle credentials, MFA, CAPTCHA, domain, or security settings;
- irreversibly delete data or may escape the dedicated Simulator/test-persona boundary.

Do not treat the known ChipK iOS `打開` prompt, ordinary App navigation, reversible test-account changes, or unfamiliar product UI as permission gates. Inspect and continue within the test boundary.

Separately, pause the affected decision/evidence branch when:

- route confidence is low or several screens are equally plausible;
- a required stock ID or other parameter is missing;
- the Simulator has no approved VIP session;
- real personal data, non-test holdings, private notifications, or non-test account details are visible;
- `live` evidence visibly contradicts the copy;
- output suitability is subjective and the user has not chosen among candidates.
