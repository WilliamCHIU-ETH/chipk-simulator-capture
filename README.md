# ChipK Simulator Capture

Contract-only preflight for an optional, independently versioned ChipK material-acquisition provider.

```text
Marketing Video
      │ MaterialAcquisitionPort
      ▼
ChipK CLI adapter
      │ versioned JSON / process boundary
      ▼
chipk-simulator-capture
```

Marketing Video must continue end-to-end when this provider is absent. Fallback selection belongs to Marketing Video, not this repository.

## Preflight commands

```bash
npm ci
npm run preflight
node bin/chipk-capture.js --version
node bin/chipk-capture.js capabilities --json
```

This branch intentionally contains no internal Builder snapshots, route catalog, persona metadata, credentials, runtime recordings, or Simulator implementation. It validates the remote repository, CLI handshake, JSON contract, and CI boundary only.

See [docs/architecture.md](docs/architecture.md) and [docs/preflight.md](docs/preflight.md).
