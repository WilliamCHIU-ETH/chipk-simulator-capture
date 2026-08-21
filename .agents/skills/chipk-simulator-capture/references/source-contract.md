# Source contract

## Canonical inputs

`config/simulator-capture.catalog.json` is the reviewed operational route contract. It contains
only the minimum route IDs, fixed/query parameters, safety flags, readiness terms, exact public
stock mapping, and known conflict resolutions needed by a clean clone. Recording behavior belongs
to `config/simulator-recording-recipes.json`.

Raw Builder responses, Sheet extracts, iOS repository snapshots, local checkout paths, private
network locations, and refresh evidence are not source artifacts. Keep them in ignored `.runtime/`
or another approved local store.

## Conflict rule

- Current reviewed iOS behavior wins for iOS route execution.
- Business wording may improve retrieval only when it does not contradict that behavior.
- Preserve known conflicts in the sanitized operational catalog.
- A new unexplained conflict blocks automatic acquisition for the affected route until reviewed.
- Fixed route parameters are part of route identity and callers cannot override them.

## Refresh procedure

1. Gather source evidence locally without copying raw responses into Git.
2. Reduce it to a schema-closed sanitized source bundle in `.runtime/`.
3. Compile a candidate with `bin/chipk-refresh-catalog.js` into `.runtime/`.
4. Review and promote only the minimal route/rule changes into the operational catalog.
5. Run catalog checks, golden cases, recipe checks, and `npm run preflight`.
6. Review the diff. Refresh never authorizes Simulator execution, commit, or push.

The catalog version identifies reviewed rules; it does not prove that every route or dynamic App
screen was freshly exercised.
