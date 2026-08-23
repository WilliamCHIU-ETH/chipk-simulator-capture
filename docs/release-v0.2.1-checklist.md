# v0.2.1 release gate

This checklist governs the proposed `v0.2.1` release only. It does not retroactively claim that the
released `v0.2.0` contains the target work.

This tool checks whether an exact-commit release checklist is complete enough to enter human
release review. It does not verify that referenced commands ran and never authorizes activation,
tagging, or release.

`readyForReleaseReview` becomes true only when every item below is either locally verified or
explicitly attested for one exact provider commit:

1. Source coverage truth keeps catalog, navigation-readiness text, content, recipe, and unclaimed
   runtime verification separate.
2. `package.json` and both package-lock identities identify `0.2.1`.
3. The provider worktree is clean at one exact commit.
4. The attestation envelope claims `npm run preflight` passed on that exact provider commit.
5. The envelope claims the P0 root-navigation regression passed on that commit.
6. The envelope claims Marketing Video v1 compatibility and provider-free
   regression passed against the same provider commit and one exact consumer commit.

Spatial OCR/readiness (`#12`), prepared mobile clip (`#13`), and the S1
Accessibility/latency runtime line are follow-up evidence for a later release decision. They are
not `v0.2.1` checklist requirements. In particular, an unresolved S1 runtime lifecycle failure must
not turn an otherwise releasable P0 patch into a permanent blocker, and Contract v1 does not depend
on the prepared-clip feature.

The tool does not run a Simulator, network request, Keychain operation, preflight, cross-repository
test, release, or tag. It reads versioned source, local Git identity, and an explicit local
attestation envelope. It only verifies the envelope shape and that its provider commit string
matches local `HEAD`; it does not verify the consumer repository commit, authenticate `evidenceRef`,
verify the attester's identity, or prove command execution.

## Local attestation envelope

Keep the envelope under ignored `.runtime/`; it is release-run evidence, not source. Use this closed
shape:

```json
{
  "schemaVersion": 1,
  "targetVersion": "0.2.1",
  "providerCommit": "<exact-provider-commit>",
  "attestations": {
    "providerPreflight": {
      "claimedStatus": "passed",
      "evidenceRef": "<reviewable-preflight-reference>"
    },
    "p0RootNavigationRegression": {
      "claimedStatus": "passed",
      "evidenceRef": "<p0-root-navigation-regression-reference>"
    },
    "crossRepoConvergence": {
      "claimedStatus": "passed",
      "evidenceRef": "<final-cross-repo-run-reference>",
      "consumerCommit": "<exact-marketing-video-commit>",
      "contractVersion": 1,
      "compatibilityTestClaim": "passed",
      "providerFreeRegressionClaim": "passed"
    }
  }
}
```

Do not put credentials, session values, private URLs, screenshots, logs, or generated manifests in
this file. The tool validates attestation fields but does not echo `evidenceRef` values. Before any
tag or release, the release owner must inspect every reference, confirm the claimed commands and
outcomes, and verify both commit identities independently.

## Commands

Generate the source-only coverage report:

```bash
npm run --silent coverage:source
```

Inspect current blockers without supplying release attestation evidence:

```bash
npm run --silent release:gate:v0.2.1
```

After P0 regression, provider preflight, release identity, and cross-repo final-commit checks are
complete:

```bash
npm run --silent release:gate:v0.2.1 -- \
  --evidence "$PWD/.runtime/release-v0.2.1-evidence.json"
```

A JSON result with `checklistStatus: "ready_for_release_review"`,
`attestationsComplete: true`, `readyForReleaseReview: true`, and an empty `blockers` array only means
the release owner can begin that manual evidence review. The result always retains
`releaseDecision: "human_required"`; it never permits a tag or release by itself.
