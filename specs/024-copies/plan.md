# Plan 024: a fixed number of copies

**Spec**: [spec.md](spec.md) · Node and Bare · no new dependency. Builds on 023 (`lib/holding.js`, `lib/circles.js`).

## Research (worker, before code)

- **R1** Where 023 picks holders: `#handTo` gives blind-peering every holder (`pick: holders.length`) and hands every
  space to all. Change it to per space: one blind-peering client per holder set, or `addCore` with an explicit target
  list if blind-peering 2.10.1 allows it (read its source; say which and why).
- **R2** Online now, per holder: from the connections the instance already has (holders' device keys) and the
  `hg/holder` records; no new pings unless needed.
- **R3** Replacement deletes (FR-006): blind-peer's `delete-core` RPC (`blind-peer/index.js:970`) from the sender;
  check a holder only accepts it from the member who handed the core (023's `held` map), never from another.
- **R4** Hourly bitmaps per holder (720 bits for 30 days) in the instance's meta, written at most every few minutes.
- **R5** Pure logic in `lib/circles.js` (split, ranking, rarest order, replacement) so the unit tests need no network.

## Order

1. Tests first (spec's list), failing.
2. Split and ranking (FR-001/002), handing per space (R1), take-over on leave (FR-003).
3. Rarest first, the extra copy, 7-day replacement with deletes (FR-004/005/006).
4. Online numbers (FR-007/008), `copiesOf()` (FR-009), `keptBy` removed.
5. Docs (`docs/next/api.md`, the circles page: FR-010), forum scenario, perf. SwarmFS and HyperBrowser suites against it.

One worker, one commit per step.

## Risks

- One blind-peering client per holder set could mean many clients: count them in perf; prefer one client per holder.
- A space's holders change when a holder joins (ranking): the new top holder fetches, the pushed-out one deletes.
  Keep it to that space, never a reshuffle of all.
