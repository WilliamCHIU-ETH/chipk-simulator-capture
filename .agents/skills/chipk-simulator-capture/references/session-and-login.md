# ChipK session and login contract

This contract was reviewed against local `IOS_ChipK` `develop` commit `42a07628c2dd35343ffd358a216c66e2d01d0737`. Re-check the source evidence and selectors when that checkout changes.

## Lifecycle vocabulary

- **Simulator boot** means the Simulator device is running. Booting a device does not prove the App is running or logged in.
- **App cold launch** means starting the App process. It runs the App's native `autoLogin` path.
- **Warm session** means the App is already running with an approved login that can be observed without relaunching it.

Treat these as separate facts. A device/tool preflight does not establish App lifecycle, login, or VIP access.

## Why a cold start can return to login

Every cold start calls `LoginModel.autoLogin`. The session is accepted only when the stored login type, GUID, access token, identity token, and refresh token are usable. The app refreshes the JWT before entering the main UI; it then fetches member profile and authorization data. A missing field, failed token refresh, network/API error, invalidated session, explicit logout, or a backend-domain mismatch can therefore return the app to login.

Here, **auto-login** means the App's own token/session recovery. It does not mean that the agent enters an account or password.

Source evidence at the reviewed commit:

- `ChipK/Screen/Login/Launching/LaunchingViewController.swift:123-176` routes every auto-login failure to `LoginViewController`.
- `Pods/CMLoginModel/CMLoginModel/CMLoginModel/Classes/CMLoginModel/LoginModel.swift:187-247` validates stored JWT fields and performs token refresh.
- The same file at `284-362` requires member-profile and authorization refreshes to finish before reporting login success.
- `ChipK/Screen/Login/LoginManager.swift:23-60` logs out when the running session is reported invalid.

Do not treat a login screen as proof that saved credentials are wrong. It is only evidence that this startup did not establish a valid session.

## Remember password is not a session switch

`記住密碼` controls password persistence and login-form prefill only. Account reference, login type, GUID, and JWT values use the app Keychain; the remember-password boolean uses UserDefaults. A successful account login stores JWT values regardless of the remember setting, so auto-login depends on JWT state rather than the remembered password.

Source evidence:

- `Pods/CMLoginModel/CMLoginModel/CMLoginModel/Classes/CMMemberProfileModel/MemberProfileModel.swift:232-334`
- `Pods/CMLoginModel/CMLoginModel/CMLoginModel/Classes/CMLoginModel/LoginModel.swift:522-560`
- `Pods/CMLoginModel/CMLoginModel/CMLoginModel/Classes/ViewControllers/LoginViewController.swift:868-897`

Leave the switch in its existing state. Its control is an image-only `UIButton`, not a stable semantic switch, and toggling it is unnecessary for establishing the JWT session.

## Approved persona and Keychain boundary

The only approved capture role is VIP. Actual persona IDs, login identifiers, and secure-store
locators belong only in ignored `.runtime/personas.local.json`; the repository versions only a
sanitized example and schema. It must not contain or reproduce a real identity, password, token,
cookie, recovery code, locator, or other runtime credential material.

Local persona metadata or secure-store presence does not prove that the App session is active or
that VIP content is unlocked, and it must never perform an automatic login. No public CLI command
prints a secure-store value. Any future authorized integration that reads one must be separately
reviewed and must never send it to stdout/stderr, a shell argument, environment dump, clipboard,
model/tool text, screenshot, OCR result, manifest, or repository file.

If the persona is missing, unapproved, not VIP, or its Keychain item is absent, pause session recovery and capture at the human gate. Independent planning or review may continue, with the final handoff disclosure required by the main skill.

## Login-page AX selectors

The reviewed login module does not assign explicit accessibility identifiers or labels to these controls. Match role plus visible text, and tolerate the current account-field wording while never reading or reporting its value:

| Purpose | AX role and selector text | Rule |
| --- | --- | --- |
| Debug domain tool | button `變更domain` | Do not tap during a normal login. |
| Account input | secure text field containing `帳號`; source placeholder `CMoney帳號(手機號碼或email)` | Its presence supports a human-login handoff; do not read or fill it in the current workflow. |
| Password input | secure text field `密碼` | Its presence supports a human-login handoff; do not fill it in the current workflow. |
| Remember-password row | static text `記住密碼` beside an image button | Do not toggle. |
| Submit | button `使用 CMoney 帳號登入` | Treat it as evidence that the approved session is not established; do not tap it in the current workflow. |

The selector text comes from `Pods/CMLoginModel/CMLoginModel/CMLoginModel/Classes/Views/LoginView.swift:263-274,420-438`; the debug button comes from `ChipK/Screen/Login/Launching/LaunchingViewController.swift:165-174`.

## Domain rule

For the normal QA capture persona, do not change domain. The reviewed app initializes its main, Identity, Profile, and Authorization services to the production `api.cmoney.tw` family. The visible `變更domain` button is a DEBUG tool, not a prerequisite for login.

If the domain is visibly marked changed, differs from the expected production family, or cannot be verified without opening unknown UI, pause session recovery and capture for human review. You may report a likely domain mismatch as inference, but do not reset or cycle through domains.

Source evidence:

- `ChipK/AppDelegate.swift:50-56`
- `ChipK/Model&Controller/DomainManager.swift:37-52`
- `ChipK/RemoteConfigDefaults.plist:5-20`
- `ChipK/Model&Controller/DomainManager+Debug.swift:17-104`

## Session check and human handoff

1. If the approved VIP session is already active, do not log in or cold-launch the App again.
2. Capture authorization does not authorize a cold launch, credential access, or session recovery. Follow the user's requested lifecycle boundary.
3. If a cold launch is explicitly allowed, observe only the result of the App's native `autoLogin`. Do not enter credentials in the currently verified workflow.
4. If the login page appears, the supported conclusion is only that this launch did not establish the approved session. You may report likely causes such as token refresh, network/API, invalidated session, or domain mismatch as inference; do not assert one without evidence.
5. On a login page, MFA, CAPTCHA, login error, credential/security prompt, or ambiguous session, pause session recovery and capture. The known iOS `要在籌碼K線中打開此網頁嗎？` prompt is not a login or permission gate: tap `打開` automatically for a reviewed ChipK Deep Link. An unfamiliar product screen is not by itself a human gate: inspect it and continue reversible exploration unless the next action crosses the external-impact boundary in the main skill.
6. When this state requires a concrete user action, end the current turn immediately: stop active tools and subagents, send the handoff in `final`, and wait for an explicit confirmation before resuming. Do not keep working or polling after asking in commentary, because that may suppress the user notification. Independent planning or prior-artifact review may continue only before the actionable gate is reached, or in the resumed turn. Any reused artifact must be labeled as prior evidence, and the final response must state that no fresh capture occurred plus the exact human action and resume point.
7. `焦點股` plus `更多` with `使用 CMoney 帳號登入` absent is one valid main-page signal, not a required waypoint. For an allowlisted read-only Deep Link, open the route before recording; if the known iOS ChipK open-confirmation appears, tap `打開` without a human gate. Treat the approved session as sufficient when the target page/stock assertions pass and `使用 CMoney 帳號登入` is absent. If it lands on login, invoke the human handoff. Start recording only after this target-page preparation succeeds, so login or navigation failures are not published as material.

The main-page texts are assigned in `ChipK/Screen/Main/MainVC/MainViewController.swift:391-407`. Its Universal Link handler is installed in `viewDidAppear` at `183-205`; a successful target-page assertion is direct evidence that the handler and session were ready, while a failed route must not be misreported as a login cause without evidence.
