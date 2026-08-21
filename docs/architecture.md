# Architecture boundary

```text
request JSON
    │
    ▼
contract validator ──► catalog planner ──► immutable plan
                                  │
                                  ▼
                           production gate
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                 ▼
          rejected result                 runtime adapter
          (shipped default)               (not shipped)
```

The repository owns request validation, route planning, readiness evaluation, and result normalization. It does not own Marketing Video fallback policy, Project asset import, presentation effects, or delivery QA.

## Source-only boundary

The committed catalog is marked `synthetic`; it validates behavior without encoding a real product route. No runtime adapter is included. As a result, the default provider reports `productionReady: false` and enables planning only.

Screenshot or recording execution requires all of the following:

1. a separately reviewed catalog marked `production-reviewed` with a SHA-256 source digest that is present in the build-owned trust store;
2. a runtime adapter that explicitly reports `productionReady: true` and supports the requested operation;
3. caller attestations for an authorized run and a dedicated Simulator.

The shipped trust store is empty, so a runtime caller cannot self-promote a catalog by recomputing its checksum. Adding a production digest requires a reviewed source change. The gate is evaluated before the provider calls the adapter; CI never accesses a Simulator, network, credential store, or provider.
