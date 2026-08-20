# Architecture boundary

```text
Marketing Video core
        │ owns MaterialAcquisitionPort and fallback policy
        ▼
ChipK CLI adapter
        │ process + JSON boundary
        ▼
Capture provider repository
```

The provider is optional. Marketing Video must not import its source, require it during installation, or fail ordinary CI when it is absent.

The future implementation may produce immutable acquisition artifacts such as `raw.mp4`, `actions.json`, and `acquisition-manifest.json`. Marketing Video remains responsible for imported Project Assets, fallback evidence, presentation composition, and `presentation-manifest.json`.
