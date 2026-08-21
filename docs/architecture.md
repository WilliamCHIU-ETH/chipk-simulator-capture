# Architecture boundary

```text
Capture Request v1
      │
      ▼
closed validator ──► operational catalog / recipe ──► runtime adapter
                                                     │
                         exact Simulator + checks ◄──┘
                                                     │
                                                     ▼
                                      caller outputDirectory only
                                                     │
                                                     ▼
                                           Capture Result v1
```

The provider owns the catalog, deterministic planning, exact-device preflight, screenshot/record
execution, evidence manifests, hashes, media metadata, and atomic publication. Marketing Video
owns whether to prefer/require/disable the provider, fallback, Project asset import, framing,
editing, rendering, and delivery QA.

## Stable boundary

Marketing Video invokes `chipk-capture acquire --request <absolute-json-file> --json`. It does not
import a provider module. Request and result schemas are closed and versioned. Successful artifact
descriptors contain only paths relative to the caller's output directory.

Simulator UDID and the authorized/dedicated/session attestations are process environment owned by
the provider runtime. They are deliberately outside Request v1 so the product Port remains about
material intent rather than provider implementation details.

## Failure boundary

- CLI or request syntax faults: JSON error on stderr, exit 2.
- Valid requests that cannot run or complete: full typed result on stdout, exit 3.
- Completed acquisition: full result on stdout, exit 0.
- No operation overwrites an artifact or publishes a partial final bundle.

`completed` means acquisition completed. Material evidence may still state
`captured_pending_human_review`; final editorial suitability remains outside this provider.
