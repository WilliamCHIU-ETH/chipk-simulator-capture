# Provider source coverage

`npm run coverage:source` emits deterministic JSON from the reviewed route catalog and recording
recipes. It is a provider-local diagnostic, not a third command on the Marketing Video Port.

The report keeps five claims separate:

| Layer | What the source can claim | Current denominator |
|---|---|---:|
| Cataloged route | A reviewed provider route ID exists | 40 / 40 |
| Navigation readiness text candidate | The catalog declares text that may indicate page readiness | 40 / 40 |
| Content text candidate | The catalog declares additional page-content text | 2 / 40 |
| Interaction recipe coverage | At least one reviewed recording recipe targets the route | 1 / 40 routes; 2 recipes |
| Runtime verification | A current App hierarchy or run observed the route | Not claimed by source |

The two current recipes use reviewed coordinate execution and text selectors. They declare no
explicit Accessibility identifier selector. Therefore the report says
`not_declared_in_provider_source`; it does not say Accessibility is unavailable. Runtime
availability stays `unknown_not_observed` until a separately authorized runtime check produces
per-run evidence.

The 40 / 40 readiness-text result is not unique route identity coverage. A text such as `K線` can
appear in multiple UI states, and a provider route ID is not an App Accessibility identifier. The
report therefore sets `navigationReadinessTextCandidate.uniqueRouteIdentity` to `false`.

Likewise, `runtimeVerifiedRoutes.numerator` and `.ratio` are `null`, not zero. Zero would claim that
a runtime verification population was actually observed and none passed. This source report has no
such population.

Run:

```bash
npm run coverage:source
```

Important JSON fields:

- `evidenceBoundary.navigationReadinessTextCandidateMeaning` is
  `catalog_text_candidate_not_unique_route_identity_or_runtime_observation`.
- `summary.*.numerator` and `denominator` make every route-level ratio explicit.
- `routes[].accessibilityIdentity` separates an explicit identifier declaration from runtime
  availability.
- `routes[].runtimeVerification` always remains `not_claimed_by_source` in this report.

This is route-level provider coverage. It is not a whole-App Accessibility audit, control-level UI
coverage, current session proof, capture success rate, or editorial suitability score.
