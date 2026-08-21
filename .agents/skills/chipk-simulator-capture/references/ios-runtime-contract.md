# iOS runtime contract

This contract was reviewed against local `IOS_ChipK` `develop` commit `42a07628c2dd35343ffd358a216c66e2d01d0737`. Re-check it when the app checkout changes.

## Stable inputs at the reviewed commit

- Workspace: `ChipK.xcworkspace`
- QA scheme/target: `ChipKTestVersion`
- Bundle ID: `CMoney.Chipk`
- Custom scheme: `chipk`
- QA compilation condition: `SWIFT_ACTIVE_COMPILATION_CONDITIONS=QAVERSION`
- Health-check route: `page=stock&subpage=26&stockid=<stock ID>`

Do not run `QA.sh` as the local build command. It also removes dependencies/DerivedData, clones, commits, and pushes. If a build is explicitly requested, invoke `xcodebuild` directly and pass the `QAVERSION` compilation condition. Do not copy old `EXCLUDED_ARCHS=arm64`; Apple Silicon should use native architecture unless a verified dependency failure requires a scoped workaround.

## Dynamic runtime checks

Do not freeze these in the skill:

- available Simulator runtime, device name, or UDID;
- whether the QA app is installed;
- login and VIP entitlement;
- Remote Config, A/B assignment, backend content, market state, or cached data;
- floating marketing-video visibility;
- Universal Link/AASA takeover.

Use a dedicated Simulator, exact UDID, and current preflight evidence. The bundle ID may collide with another installed build, so installation can replace it and its session.

## Navigation behavior

Prefer the allowlisted custom scheme for deterministic Simulator routing:

```text
chipk://www.cmoney.tw/app/landing_page/chipk?page=stock&subpage=26&stockid=2330&stockname=%E5%8F%B0%E7%A9%8D%E9%9B%BB&noReloadApp=1
```

The app rewrites this to the HTTPS form before normal routing. This tests in-app routing but does not prove the production Universal Link, signing entitlement, or AASA file.

Deep Links dispatch only after login. If the approved VIP session is absent, use the bounded approved-persona flow in `session-and-login.md` only when the user authorized login/capture in that turn. Do not embed plaintext credentials, patch user defaults, invoke private selectors, or bypass authentication; stop at the human gate on any unexpected login state.
