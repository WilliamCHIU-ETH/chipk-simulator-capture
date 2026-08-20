# Contract-only preflight acceptance

This preflight succeeds when:

1. The private GitHub repository and feature branch exist.
2. The CLI reports a versioned capability document.
3. Request and result JSON schemas are present.
4. GitHub Actions runs without a Simulator, credentials, or internal snapshots.
5. Marketing Video can probe the CLI without importing this repository.
6. Marketing Video continues through fallback when the provider is absent or not production-ready.

It does not claim a fresh capture, production readiness, recipe parity, final-timeline B-roll consumption, daemon ownership, or warm-session stability.
