# v0.2.1 release gate

This checklist governs the proposed `v0.2.1` release only. It does not retroactively claim that the
released `v0.2.0` contains the target work.

Activation and tagging stay blocked unless every gate below reports `pass` for one exact provider
commit:

1. Source coverage truth keeps catalog, navigation-readiness text, content, recipe, and unclaimed
   runtime verification separate.
2. `package.json` and both package-lock identities identify `0.2.1`.
3. The provider worktree is clean at one exact commit.
4. `npm run preflight` passed on that exact provider commit.
5. The P0 root-navigation regression passed on that exact provider commit.
6. Marketing Video v1 compatibility and provider-free regression both passed against the same
   final provider commit and one exact consumer commit.

Spatial OCR/readiness (`#12`), prepared mobile clip (`#13`), and the S1
Accessibility/latency runtime line are follow-up evidence for a later release decision. They are
not `v0.2.1` activation gates. In particular, an unresolved S1 runtime lifecycle failure must not
turn an otherwise releasable P0 patch into a permanent blocker, and Contract v1 does not depend on
the prepared-clip feature.

The gate does not run a Simulator, network request, Keychain operation, release, or tag. It reads
versioned source, local Git identity, and an explicit local evidence envelope. Missing, failed,
stale, or mismatched evidence produces `blocked`.

## Local evidence envelope

Keep the envelope under ignored `.runtime/`; it is release-run evidence, not source. Use this closed
shape:

```json
{
  "schemaVersion": 1,
  "targetVersion": "0.2.1",
  "providerCommit": "<exact-provider-commit>",
  "gates": {
    "providerPreflight": {
      "status": "passed",
      "evidenceRef": "<reviewable-preflight-reference>"
    },
    "p0RootNavigationRegression": {
      "status": "passed",
      "evidenceRef": "<p0-root-navigation-regression-reference>"
    },
    "crossRepoConvergence": {
      "status": "passed",
      "evidenceRef": "<final-cross-repo-run-reference>",
      "consumerCommit": "<exact-marketing-video-commit>",
      "contractVersion": 1,
      "compatibilityTest": "passed",
      "providerFreeRegression": "passed"
    }
  }
}
```

Do not put credentials, session values, private URLs, screenshots, logs, or generated manifests in
this file. The gate validates the evidence fields but does not echo `evidenceRef` values.

## Commands

Generate the source-only coverage report:

```bash
npm run coverage:source
```

Inspect current blockers without supplying release evidence:

```bash
npm run release:gate:v0.2.1
```

After P0 regression, provider preflight, release identity, and cross-repo final-commit checks are
complete:

```bash
npm run release:gate:v0.2.1 -- \
  --evidence "$PWD/.runtime/release-v0.2.1-evidence.json"
```

Only a JSON result with `releaseStatus: "pass"`, `activationAllowed: true`, and an empty
`blockers` array allows the release owner to proceed to the separate tag/release step. This
repository tool never performs that step.
