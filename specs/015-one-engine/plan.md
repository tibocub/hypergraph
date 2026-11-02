# Implementation Plan: One engine for many sites

**Branch**: `015-one-engine` | **Date**: 2026-11-01 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md); design reasons and measurements in [research.md](research.md), states and
fields in [data-model.md](data-model.md), API in [contracts/api.md](contracts/api.md).

## Summary

One `Hypergraph` instance becomes an engine for many apps and sites: each top space records its types in
its decision log (`types/set`, the one apply-time change) and is indexed with them alone; spaces stay
closed until used and close when idle, with a capped seeded set; topics go through one priority queue
paced under the DHT node's request window (80 per 750 ms, measured: `research.md` R1) with an announce
cap; logs inside a space open only while used; a scoped handle gives a site its own spaces and nothing
else; `suspend()`/`resume()` for phones. Single-app use (forum, SwarmFS) keeps its API and behavior.

## Technical Context

**Language/Version**: JavaScript, Node 26 and Bare (`lib/`, hypergraph/next).

**Primary Dependencies**: corestore 7, hypercore 11, autobase 7, hyperdb, hyperswarm 4.17.2, hyperdht
6.32.0 (pinned), dht-rpc 6.27.0. No new dependency.

**Storage**: one Corestore (`cores/`) and one HyperDB index (`index/`) per engine, `instance.json`, `logs`.
Index rows gain fields; `@hg/meta 'types'` becomes per space (`data-model.md`).

**Testing**: brittle; `test/next/unit`, `test/next/forum` (scenario tests), `npm test`, `test:next:bare`;
`npm run perf` (perf-habit branch, see Dependencies).

**Target Platform**: desktop (Node, Pear later) and phones (Bare, short runs).

**Project Type**: library.

**Performance Goals**: SC-001–SC-007: 500 held spaces ready < 1 s, < +50 MB, visit < 100 ms, visited topic
not delayed by background joins, ~20 open logs.

**Constraints**: the DHT request window is upstream's (not raised); site code never runs in the engine;
no wire change; one apply-time change.

**Scale/Scope**: 500 held spaces per engine, a few open; 2,000+ logs per space.

**Decided by Tibo (2026-11-02)**: per-site keys by default (API now, derivation later); types recorded
only automatically by a decider's app; caps 64/32 desktop, 16/8 phone; one personal-space type namespace
with prefixes. See `spec.md` "Decisions".

**Dependencies on other work** (code starts only after `decisions-in-place` merges and the forum trial
ends):
- `lib/decisions/` is being changed now (decisions applied in place, session `decisions-in-place`):
  `types/set` lands after it merges, on its new apply path.
- `npm run perf` (perf-habit branch): the perf scenarios land after it merges.
- The "open spaces at scale" spec (ROADMAP "Now" 10a) is ordered before this one; both touch the
  directory. This spec's log closing (R4) is local and doesn't depend on it.

## Constitution Check

*Before Phase 0 and again after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Correctness under concurrency & partition | `types/set` applied deterministically (writer may decide, compatible with the state at its place in the order); concurrent ones: the second must be compatible with the first. Closed spaces apply missed decisions at reopen (Autobase catches up). Closing never drops pending writes. | pass |
| II. Test-first for replication | `types/set` apply tests (unit, decisions), two members, forged and concurrent cases, written before code; log closing with a newcomer fetching closed logs (`test/next/` replication); migration fixture from master. | pass (in tasks) |
| III. Thin composition | Uses Corestore's on-demand serving, Hyperswarm's suspend/resume, Autobase as is; the topic queue only orders `swarm.join` calls. | pass |
| IV. One coherent API | Laziness is invisible (async calls open); no `openSpace`/`closeSpace` to manage; one scoped object for sites. `space.ready()` is the one new rule for sync getters. | pass |
| V. Explicit breaking changes | Apply-time `types/set` (everyone updates together); `INCOMPATIBLE_TYPES` moves from open to the space; CHANGELOG entry with migration. | pass |
| Doc-sync | `docs/next/api.md` (open options, types, lazy spaces, scope, suspend), `docs/next/concepts.md` (types live in the space, engine), CHANGELOG, ECOSYSTEM.md note for SwarmFS. | in tasks |
| Rule 3: forum scenarios | Changes listed below, in the same change. | in tasks |

No violations; no Complexity Tracking.

## Design

### A. Types per space (`lib/types.js`, `lib/decisions/*`, `lib/space.js`, `lib/index.js`) — **apply-time**

- `Types.from(describe)` builds a `Types` from the stored form (inverse of `describe()`), with the
  built-ins added.
- Decision `types/set { version, types }` (apply: `data-model.md`); each version kept as its own view
  entry `types:<n>` (room for several versions later, spec "Future direction"). State `types`,
  `typesVersion`. Only a decider's app writes it, automatically at open; no public call.
- Each `Space` has `this.types`: from `state.types` when set, else the engine's declaration (old
  spaces); sub-spaces take their top space's. On a `typesVersion` change: if only types or indexes were
  added and rows of them exist in this space, re-index this space only (delete its rows, `#restore` for
  one space); else nothing.
- Engine `#reindex` becomes per space; the global `checkCompatible` at open goes away (each space checks
  at its open).
- `createSpace({ types })` writes `types/set` with `space/init`. At a space's open, a decider whose app
  declaration ⊋ the space's and is compatible writes `types/set`; incompatible → `INCOMPATIBLE_TYPES`
  from that space's calls (the engine still opens).
- Personal space: union of attached apps' types, local (R6).

### B. Lazy spaces (`lib/index.js`, `lib/space.js`)

- `_open` builds closed `Space` shells for every row; opens the seeded set through the open queue.
- `Space`: `opened`, `ready()`, `_ready()` in every async method, `_use()/_unuse()` refcount, `hold()`;
  `close()` → back to a shell (reusable), not a dead object.
- Engine: `#openQueue` (one open at a time per space, as `_opening` does), LRU by `used`, `maxOpen`,
  `memory` estimate (R3), idle timer per space.
- `#settle`, `_openSubspaces`, `_writeHeads`, budgets: rows for closed spaces, no opening (R9).
- `pin`/`unpin`/`pinned` (setting `pinned` in the personal space).

### C. Topic queue (`lib/network.js`)

- `join(space, priority)` / `leave(space)` enqueue; one background job in flight, awaiting `flushed()`;
  priority 0 runs at once. `announced` set ≤ `maxAnnounced` (own, pinned, recent), others `{ server:
  false, client: true }` only while in use, else no topic.
- `#relook` only while the space is in use.
- Connections attach only open spaces; a space opening attaches to every live connection (exists).
- `suspend()`/`resume()` → `swarm.suspend()`/`resume()`, queue paused.

### D. Logs open while used (`lib/directory.js`, `lib/replication.js`, `lib/space.js`) — local

- Directory entries without a core; open on own / behind / read beyond index / budget; close after 30 s.
- "Behind" from activity entries and heads already received (R4). Corestore serves closed ones.

### E. Scoped handle (`lib/scope.js`, new)

- `hg.scope(keyOrInvite, { identity })` → object exposing the `Space` methods of one top space and its
  sub-spaces (an allow-list), `on/off` filtered, `identity`, `close()`. Holds the space in use.
- Per-site key by default (research R5b): held spaces record `as`; `identity: 'main'` opens under the
  main identity. The derivation is a follow-up spec: until then the default throws `NOT_SUPPORTED`.

### F. Migration (`lib/index.js`, `lib/instance.js`)

- Folder from master: global `@hg/meta 'types'` → `types:<space>` for every row, no re-index; global
  kept while any space lacks its own. `instance.json` gains per-space fields.
- No downgrade (an older version can't apply `types/set`).

## What is apply-time / format vs local

| change | kind |
|---|---|
| `types/set` decision and its apply rule; state `types` used by readers to enforce `editable`, `put`, `onePerMember`, links | **apply-time + format** (everyone updates together) |
| lazy spaces, LRU, seeded set, pins (a personal-space setting: existing record type) | local |
| topic queue, announce cap, re-looks, suspend/resume | local (no wire change) |
| logs open while used | local |
| per-space index re-build, `@hg/meta` / `instance.json` layout | local (folder format, migrated forward) |
| scoped handle | local API |
| `as` on `hg/space` records (trailing field, personal space only) | format, read only by the person's own devices (older versions ignore it) |

## Forum scenario tests: expected changes (rule 3)

- `versions.js`: "any other change to the types is refused at open" → refused at the space (a decider's
  open of the forum throws `INCOMPATIBLE_TYPES` on its calls; the engine opens); a forged incompatible
  `types/set` ignored by every member (new). "Records of a type the app doesn't know": the newer app
  writes polls after the owner's updated app opened the forum (the owner records the version); before
  that, a plain member's `put('poll')` throws `INCOMPATIBLE_TYPES`. Old apps now decode new fields (they
  get the space's types): assertions on "kept, not decoded" change to "kept and decoded".
- New `engine.js` (forum + wiki + a site in one engine, no engine `types`): each space with its own
  types; a wiki type change doesn't touch the forum's index; a scoped handle for the wiki can't reach the
  forum or the personal space; a default handle throws `NOT_SUPPORTED` until per-site keys exist, one
  opened with `{ identity: 'main' }` works and shows the main identity.
- New `lazy.js`: a member holding 100 forums (`maxOpen` 8): opens one on visit, reads, posts, closes on
  idle; a post arriving while closed shows at the next visit; pinned forums stay online.
- `rebuild.js`: index rebuild still whole-folder after loss; a types change rebuilds one space (new test).
- `sign-up.js`, `subforums.js`: sub-forums use the forum's types (no `types` on `subspace/create`).
- Everything else: unchanged (fewer spaces than `maxOpen`).

## Consumers

- **forum example** (`E:\Code\P2P\hypergraph-forum-example`): no code change needed (`Hypergraph.open`
  with `types` keeps working; the forum's space gets `types/set` at the owner's first open). Re-pin and
  run its tests; tell it in `specs/requests-to-hypergraph.md` that a member's newer version waits for an
  admin's open (or the follow-up in open question 2).
- **SwarmFS**: `SwarmFS.open(dir)` unchanged (own engine). New `new SwarmFS(hg)` on a shared engine
  (HyperBrowser milestone 2): its spaces get its types; its personal-space types prefixed (`held` →
  `swarmfs/held`: a rename while it's unreleased, its own change). Its suite must pass against this
  working tree after each phase.
- **HyperBrowser**: engine with no `types`; one `hg.scope(siteKey)` per web view (per-site key; the main
  identity only with the person's yes, remembered per site); pins = bookmarks; `suspend/resume` on mobile.
- **hyperDNS, HyperBBS**: v1, untouched.

## Phases (for `/speckit-tasks`)

1. Topic queue + announce cap + re-looks (C) — local, smallest, independent; perf `topics`.
2. Lazy spaces (B) + perf `engine` — local.
3. Types per space (A) + migration (F) — apply-time, after `decisions-in-place` merges.
4. Logs open while used (D) + perf `logs`.
5. Scoped handle (E), suspend/resume, Bare run.
6. Docs, CHANGELOG, consumers' suites (forum example, SwarmFS).

## Project Structure

```text
specs/015-one-engine/
├── spec.md, plan.md, research.md, data-model.md, quickstart.md
├── contracts/api.md
└── checklists/requirements.md
bench/one-engine/topics.mjs        # R1, exists
lib/index.js, lib/space.js, lib/network.js, lib/types.js, lib/directory.js, lib/replication.js,
lib/instance.js, lib/decisions/*, lib/scope.js (new)
test/next/unit/{space-types,lazy,topic-queue,scope}.js, test/next/forum/{engine,lazy}.js
perf/scenarios/{engine,topics,logs}.mjs
```

**Structure Decision**: all in the existing `lib/` (hypergraph/next); one new module for the scoped handle.
