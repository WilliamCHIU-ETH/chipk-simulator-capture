# Blank-session Simulator environment contract

## Decision

Use an independent, pinned release clone as the executable runtime and an ignored local machine
profile as the only persistent handoff. Do not update the dirty canonical checkout, depend on a
linked/detached workspace worktree, change global `xcode-select`, or persist per-run attestations.

The alternatives were:

| Option | Result |
|---|---|
| Update canonical main | Rejected: it can collide with dirty user changes and does not create an immutable runtime. |
| Reuse a linked/detached worktree | Rejected: its lifecycle is workspace maintenance, not installation. Doctor detects the shared Git common directory and blocks it. |
| Independent release clone | Selected: exact tag/commit are verifiable, lifecycle is explicit, and no existing checkout is changed. |

The selected runtime directory must be operator-owned, stable, and outside `worktrees/`. Clone the
annotated release tag into a new directory; never replace an existing directory in place:

```bash
git clone --branch v0.3.0 --depth 1 \
  https://github.com/WilliamCHIU-ETH/chipk-simulator-capture.git \
  /absolute/stable-runtime/chipk-v0.3.0
cd /absolute/stable-runtime/chipk-v0.3.0
npm ci
npm run preflight
```

For v0.3.0 the expected resolved commit is
`586fbe7414ab0c25d78ae6e462887fe72030e0a7`. The machine profile pins both version and commit;
doctor independently checks Git HEAD and `capabilities --json`.

## Persistent machine identity

`.runtime/machine-profile.json` contains only:

- the standalone Provider executable and exact release identity;
- the verified full-Xcode `DEVELOPER_DIR`;
- one exact Simulator UDID assigned the `dedicated-test-simulator` machine role.

The profile is closed. `CHIPK_CAPTURE_AUTHORIZED`,
`CHIPK_DEDICATED_SIMULATOR_CONFIRMED`, and `CHIPK_VIP_SESSION_CONFIRMED` are rejected anywhere in
it. The dedicated machine role identifies the intended device; it does not attest that the device,
account, and session remain safe for a particular run.
Creating the profile requires `--confirm-dedicated-machine-role`; a merely Booted device is never
silently promoted to the dedicated role.

## Side-effect-free doctor

`chipk-capture-machine doctor --json` may only:

1. read the local profile and Provider release identity;
2. invoke Provider `capabilities --json` with run attestations removed;
3. invoke `/usr/bin/xcrun` with `DEVELOPER_DIR` set only in the child environment;
4. list available Simulator devices and match exactly one configured UDID.

It does not call `xcode-select`, boot a device, open/launch the App, inspect a user session, acquire
media, or write Project/Revision/Run state. Important blockers include:

- `MACHINE_PROFILE_MISSING` / `MACHINE_PROFILE_INVALID`;
- `PROVIDER_INSTALLATION_UNSTABLE`, `PROVIDER_COMMIT_MISMATCH`,
  `PROVIDER_IDENTITY_MISMATCH`;
- `XCODE_DEVELOPER_DIR_MISSING`, `SIMCTL_UNAVAILABLE`;
- `SIMULATOR_NOT_FOUND`, `SIMULATOR_IDENTITY_AMBIGUOUS`, `SIMULATOR_NOT_BOOTED`.

`READY` is deliberately scoped to `simulator_environment_only`. App launch state, login/VIP
readiness, output suitability, Project Asset import, Revision selection, placement, render, and
delivery remain unproven.

## Per-run launcher

The launcher requires all three explicit flags on every invocation. Only after doctor returns
READY does it set the exact UDID, `DEVELOPER_DIR`, authorization, dedicated-device attestation,
and VIP-session attestation on the Provider child process. Nothing is exported to the parent shell
or written back to the profile. A caller that has not freshly established the App/session gate
must not supply the flags.
