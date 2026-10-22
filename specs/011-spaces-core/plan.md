# Implementation Plan: Spaces — hypergraph's redesigned core

**Branch**: `011-spaces-core` | **Date**: 2026-10-08 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/011-spaces-core/spec.md`

## Summary

A new core beside v1: typed records appended to one log per device per space; one small ordered decision
log per space (Autobase) for members, roles, moderation, invites, keys and sub-spaces; every member
checks records against the decisions and the app's rules before keeping, indexing or passing them on;
each member indexes what it holds in HyperDB and answers reads within a bound, saying when an answer is
incomplete. One instance holds one identity, a personal space shared by its devices, and many spaces, in
one storage folder over one set of connections. Runs and is tested on Node and Bare. Proven by forum
scenario tests built story by story. Decisions and reasons: [research.md](research.md).

## Technical Context

**Language/Version**: JavaScript (CommonJS, like the repo); Node (repo's current) and Bare 1.27+

**Primary Dependencies**: hypercore, corestore, autobase, hyperswarm, protomux, hyperdb + hyperschema,
keet-identity-key, blind-pairing (to verify on Bare), compact-encoding, hypercore-crypto,
sodium-universal, b4a, z32, bare-fs/path/os/events/process via an `imports` map (research R2, R3)

**Storage**: per instance folder: Corestore (`cores/`) for all logs; HyperDB on RocksDB (`index/`) for the
local index and metadata

**Testing**: brittle on Node and on Bare (`brittle/bin/bare.js`); network tests on a local DHT
(hyperdht testnet); forum scenario tests with three members; benchmarks in `bench/next/`

**Target Platform**: desktop (Windows, Linux, macOS) under Node now; Pear (desktop, Android, iOS) later via
Bare

**Project Type**: library (`require('hypergraph/next')`)

**Performance Goals**: members agree on a write within 1 s (local); 50 writers visible within 2 s;
newcomer's first page ≤ 2 s and ≤ 1 MB at 10k and 1M records, 1M ≤ 1.5× 10k; index rebuild of 100k ≤ 30 s;
queries ~1 ms from the index (experiment 2)

**Constraints**: no read waits past its bound (default 5 s); disk within budgets (+10%); no Node built-ins,
no `Buffer`, no `process` global in `lib/`; v1 (`src/`) untouched; dev machine load limits (short benches
by default)

**Scale/Scope**: spaces from 1 to thousands of members, up to 1M records per space measured (10M
designed for through story 9's activity lists); ~35 requirements over 9 stories

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Check | Status |
|---|---|---|
| I. Correctness under concurrency & partition | Decisions ordered by Autobase, applied deterministically with permission checks at their point in the order; records need no agreement and converge by append-only logs + deterministic "latest wins" (stamp, then device key); cuts by length (bans, device removals) are order-independent; edge cases listed in the spec are each a test (US1–US9). | PASS |
| II. Test-first for replication & encoding | Every task touching the decision log, the gate, the log directory, encodings or replication starts with a failing brittle test (tasks.md); forum scenarios are written before each story's code. Tests live in `test/next/` (the new tree's equivalent of `core/`, `networking/`, `replication/`). | PASS |
| III. Thin composition over Holepunch primitives | Hypercore (logs), Autobase (decisions), Corestore, Hyperswarm + Protomux, HyperDB, keet-identity-key, blind-pairing; nothing reimplemented. The log-directory gossip is our own small protocol: justified below. | PASS (1 justified item) |
| IV. One coherent API surface | One convention (R18): `Hypergraph.open` static, instance methods otherwise, `{ items, complete }` reads, `HypergraphError` codes. `connectToSwarm()` owns all wiring: no `store.replicate()` or connection handling by apps; app protocols plug into connections hypergraph already manages. | PASS |
| V. Alpha versioning, explicit breaks | New entry point `hypergraph/next`; v1 untouched; CHANGELOG entry per merged story, linking here. The later switch of `require('hypergraph')` is its own spec. | PASS |
| Doc-sync-on-change | New docs in `docs/next/` (concepts, API, deleting and incomplete answers) written with each story; v1 docs untouched because v1 code is untouched. | PASS |
| Regression test on change | Every fix during implementation adds a failing-first test (tasks.md rule). | PASS |

Re-check after Phase 1 design: PASS (no new violations; the data model and contract keep to R18 and to
Holepunch primitives).

## Project Structure

### Documentation (this feature)

```text
specs/011-spaces-core/
├── spec.md
├── plan.md              # this file
├── research.md          # decisions R1–R20
├── data-model.md        # what is stored where
├── quickstart.md        # how to validate
├── contracts/api.md     # the public API
├── checklists/requirements.md
└── tasks.md             # /speckit-tasks
```

### Source Code (repository root)

```text
lib/                          # the new core (hypergraph/next)
├── index.js                  # Hypergraph: open, identity, devices, spaces, network, budgets
├── space.js                  # Space: records, queries, graph, roles, moderation, invites, sub-spaces, protocols
├── errors.js                 # HypergraphError + codes
├── encodings.js              # log header, records, decisions, channel messages (compact-encoding)
├── fields.js                 # tagged field encoding (experiment 6)
├── types.js                  # type declarations, validation, compatibility check
├── stamp.js                  # "latest wins" stamps (R7)
├── identity.js               # keet-identity-key identity, device proofs (from src/identity-manager.js)
├── pairing.js                # join by code (blind-pairing)
├── log.js                    # a device's log in a space (header, append)
├── decisions/
│   ├── log.js                # the decision log (Autobase; from src/v2/control.js)
│   ├── apply.js              # deterministic apply + permission checks
│   └── state.js              # members, roles, moderation, invites, epochs, sub-spaces, settings
├── gate.js                   # readers enforce: checks before keep/index/pass (R11)
├── directory.js              # log directory + space channel (R10; experiment 1)
├── index/
│   ├── build.js              # HyperDB definition builder (run by us, output committed)
│   ├── spec/                 # generated hyperschema + hyperdb definition
│   ├── helpers.js            # map functions (links, app keys)
│   ├── indexer.js            # write queue, indexing, cuts, rebuild
│   └── query.js              # fluent queries, live, counts, sums, bounded reads
├── replication.js            # downloads, stall/retry, budgets, eviction (from src/v2/replication.js)
├── network.js                # Hyperswarm, topics, re-look, channels, app protocols
├── private/
│   ├── crypto.js             # from src/v2/crypto.js
│   └── grants.js             # grants as records (from src/v2/grants.js)
├── invites.js                # from src/v2/invites.js
└── personal.js               # the personal space (devices, spaces, settings, device heads)

test/next/
├── unit/                     # encodings, fields, types, stamps, apply, gate, query (no network)
├── net/                      # two-three peers on a local DHT (directory, replication, bounded reads)
├── forum/                    # forum scenario tests + forum.js (the reference app code, < 400 lines)
└── helpers.js                # local DHT, temp dirs, teardown (from test/brittle/helpers.js)

bench/next/                   # first-page, writers, rebuild, budgets, activity (story 9)
docs/next/                    # concepts.md, api.md, deleting-and-incomplete.md
```

**Structure Decision**: a separate `lib/` tree beside `src/` (v1) and `src/v2/` (frozen prototype),
exposed as `hypergraph/next` (R1). Reused modules are copied into `lib/` and adapted (b4a, Bare,
new names), never imported from `src/`.

**Carried over (adapted)**: `src/identity-manager.js`, `src/v2/control.js`, `src/v2/crypto.js`,
`src/v2/grants.js`, `src/v2/invites.js`, `src/v2/replication.js`, parts of `src/v2/encodings.js` and
`src/v2/author-log.js`, `src/networking.js`'s re-look, `test/brittle/helpers.js`; from experiments:
`bench/experiments/hyperdb/build.js`, `bench/experiments/schema/encoding.js`,
`bench/experiments/activity/gossip.js`, `bench/experiments/spike/space.js` (patterns, not code).

## Build order

Stories in the spec's order. Each story ends with its forum scenarios passing on Node and Bare, its docs
in `docs/next/`, a CHANGELOG line, and a review in the lead conversation before the next starts.

1. **Foundation**: package wiring (exports, imports map, deps), test runner group, helpers, errors,
   encodings, fields, types, stamps, identity, the index definition.
2. **Story 1** (forum basics): device logs, decision log (create, members), directory, gate (membership
   only), indexer, queries, live, network, forum scenarios 1.
3. **Story 2** (rules): roles, permissions, moderation, cuts, app rules, gate complete.
4. **Story 3** (devices, personal space): pairing, attestation, personal space, device heads, removal.
   → **SwarmFS can start.**
5. **Stories 4–9** in order.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| Our own small Protomux protocol for the log directory (Principle III: not a Holepunch primitive) | Members must learn which device logs write in a space and pass that on after checking membership; no primitive does "a gossiped, membership-checked set of core keys" | Registering logs in the decision log: only writers can write it, and spec 007 R2 measured the memory cost; deriving log keys from device keys: needs a public per-identity device list, i.e. another log per identity |
