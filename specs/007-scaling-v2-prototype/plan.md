# Implementation Plan: Scaling v2 Prototype

**Branch**: `007-scaling-v2-prototype` | **Date**: 2026-10-06 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/007-scaling-v2-prototype/spec.md`

## Summary

A prototype community data model in `src/v2/`, next to the v1 API and not wired into it: a small
admin-written control log per community (Autobase), channel messages in authors' own per-channel
logs (Hypercore), time segments fixed by each channel's record, per-channel rosters kept by
`keeper` members (single-writer Hyperbee), a local RocksDB for what a peer has shown, replication
`all | sparse | auto`, and moderation from the control log. Measured with a v2 chat benchmark at
10k → 10M messages and compared to v1. Design decisions and the two experiments behind them:
[research.md](./research.md).

## Technical Context

**Language/Version**: JavaScript, Node.js 26 (CommonJS, as the rest of hypergraph)

**Primary Dependencies**: Corestore, Hypercore, Autobase, Hyperbee, protomux-wakeup (already
used), `rocksdb-native` (already installed under Corestore; becomes a direct dependency),
hypercore-crypto, compact-encoding

**Storage**: Corestore (logs, control log, rosters); local RocksDB per peer (shown pages, local
decisions)

**Testing**: brittle, `test/brittle/v2/` (new runner group `v2`), local DHT/in-memory streams

**Target Platform**: Node.js desktop/server (Bare later, as v1)

**Project Type**: library module (prototype)

**Performance Goals**: spec SC-001..SC-008 (latest page ≤ 2 s at any size, arrival p50 < 100 ms,
throughput ≥ 5× one v1 indexer)

**Constraints**: no forks of dependencies; dev machine load limits (CLAUDE.md); v1 behavior
unchanged; HyperBBS and hyperDNS green

**Scale/Scope**: channels of 10k → 10M messages, up to ~1,000 active authors per segment, ~100
live writers, communities of 1,000 → 50,000 members

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| principle | check | status |
|---|---|---|
| I. Correctness under concurrency & partition | Every peer derives membership, roles, bans, hides and keepers from the same control log (Autobase); messages need no agreement on order and are ordered deterministically by (claimed time, author, seq); rosters are unions, signed per entry. Partial holders apply moderation (US3). | PASS |
| II. Test-first for replication | Every v2 module starts with a failing `test/brittle/v2/` scenario: partial replication, late joiner, out-of-order arrival, offline restart, adversarial entries (forged roster entry, backdated post, banned author). | PASS |
| III. Thin composition | Built from Autobase, Hypercore, Hyperbee, Corestore, Hypercore extensions, rocksdb-native. The keeper roster is a plain single-writer Hyperbee; announcements use Hypercore's extension messages, not a new transport. | PASS (see Complexity Tracking for the local RocksDB) |
| IV. One coherent API | Prototype API under `require('hypergraph/v2')` (`Community`), explicitly unstable, owning its own replication wiring (`community.replicate(stream)`), not mixed into `graph.*`. Decided here, once. | PASS |
| V. Alpha versioning | Additive: v1 unchanged. CHANGELOG entry says "prototype, unstable". | PASS |
| Doc-sync / regression tests | `docs/v2-prototype.md` + bench README + research note updated with each measured step. | PASS |

Re-check after Phase 1 design: unchanged (PASS).

## Project Structure

### Documentation (this feature)

```text
specs/007-scaling-v2-prototype/
├── spec.md
├── research.md          # R1–R9: experiments and decisions
├── plan.md              # this file
├── data-model.md        # entities, keys, records
├── quickstart.md        # how to run the prototype and its benchmark
├── contracts/
│   └── api.md           # the prototype API
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
src/v2/
├── index.js             # Community (public prototype API)
├── control.js           # control log: Autobase apply, records, rules (members, roles, bans, hides, channels, keepers)
├── author-log.js        # an author's per-channel log: key derivation, append, read range
├── roster.js            # keeper side (single-writer roster bee, announce handling) and reader side (union of rosters)
├── segments.js          # segment arithmetic, clock-skew bound
├── reader.js            # latest page, scrollback, live follow, merge by (time, author, seq), moderation filter
├── replication.js       # all | sparse | auto, budget, download ranges
├── local.js             # local RocksDB: shown pages, decisions
└── encodings.js         # compact-encoding for messages, roster entries, announcements

test/brittle/v2/
├── control.js           # roles, bans, hides, channels, keepers; deterministic on every peer
├── author-log.js
├── roster.js            # announce, forged/backdated entries, union of keepers
├── reader.js            # latest page, scrollback, live, merge order
├── moderation.js        # partial holders, late joiners
├── replication.js       # all / sparse / auto
└── offline.js           # restart offline

bench/
└── v2-chat.js           # v1 chat scenario on v2: 10k → 10M, live, newcomer
```

**Structure Decision**: one library, prototype isolated in `src/v2/` with its own tests and
benchmark; `package.json` gains an `exports` entry `./v2` and the test runner a `v2` group. v1
files are not modified except `package.json` and the runner.

## Phases (delivery order, each measured before the next)

1. **Foundation**: encodings, segments, control log, author logs (with tests).
2. **US1 + US2 (P1)**: keepers and rosters, reader (latest page, scrollback, live), `bench/v2-chat.js`
   at 10k / 1M / 10M, live arrival, throughput with ~100 writers. Gate: SC-001..SC-004 measured.
3. **US3 (P1)**: bans and hides on partial data and for late joiners (SC-006).
4. **US5 (P2)**: memory and idle cost with many members and channels (SC-005).
5. **US4 (P2)**: replication modes and budget, helper `all` (SC-008).
6. **Offline and polish**: local RocksDB pages, offline restart (SC-007), docs, comparison table
   v1 vs v2 in the research note. Compaction by archivers (FR-010, MAY) only if Phase 2 shows
   segments with more active authors than R1's comfortable range.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| A local RocksDB beside Corestore (not one of the composed primitives listed in III) — **not built: the offline test passed without it (research R6, revised)** | A peer's private state must be deletable and readable offline without depending on a replicated structure's latest version (v1 offline bug, R6) | A local Hyperbee: every entry is a signed, permanent block (~183 B overhead, never deletable); HyperDB: a schema build step for a few keys |
