# Implementation Plan: Logs open only while used

**Branch**: `017-logs-open-while-used` | **Date**: 2026-11-06 | **Spec**: [spec.md](spec.md)

**Input**: [spec.md](spec.md); reasons in [research.md](research.md), fields in [data-model.md](data-model.md),
checks in [quickstart.md](quickstart.md). No public API change (FR-010), so no `contracts/`.

## Summary

A held log is a directory entry with a cached length and size; its core is opened by `directory.open(log)` and
closed ~30 s after the last `release(log)` (R1). Every read of blocks goes through `directory.get/has/use` (R5).
The directory summary's digest and the range exchange cover each log's length (R2): a peer with more of a log is
found by the same exchange that finds a missing log, and the log is opened and downloaded (R4). A closed log is
heard once the last summary of every connected peer was settled with this member (R3). Helpers get a log open for
the hand-off only, and again when it grows (R6). Protocol `hypergraph/space/2` → `/3`.

## Technical Context

**Language/Version**: JavaScript, Node 26 and Bare (`lib/`, hypergraph/next).

**Primary Dependencies**: corestore 7.13, hypercore 11, blind-peering 2.10, protomux. No new dependency.

**Storage**: no format change for logs, records or index rows. The per-log counters in `@hg/meta` (`droppedName`,
JSON) gain `len`, `bytes`, `admitted` (cached length, size and header code). Old data without them: the core is
opened once at space open to read them.

**Testing**: brittle; `test/next/unit` (ranges with lengths, assumption checks), `test/next/net` (closed logs,
hand-off), `test/next/forum` unchanged (rule 3); `npm run perf` with `logs.held-start` (flat) and
`logs.length-settle-kb` (SC-004).

**Target Platform**: desktop (Node), phones (Bare). **Project Type**: library.

**Performance Goals**: SC-001 ≤ ~20 open cores at 2,000 logs; SC-002 `logs.held-start` flat 1k→10k (per held
log it costs a row read, no core); SC-004 under 3 KB to settle a one-log length difference.

**Constraints**: wire change (`/3`, everyone updates together); spec 012 honest reads must hold.

## Constitution Check

- I (correctness under partition): R3 never says complete while a connected peer's last summary is unsettled
  or a claim is unmet; tests with the reader connected and offline-then-reconnecting. ✅
- II (test first): assumption checks first (done: `test/next/unit/closed-serve.js`, `test/next/net/handoff.js`);
  ranges unit tests and the closed-logs net test before the code. ✅
- III (thin composition): corestore serves closed cores itself (`_attachMaybe`), blind-peering unchanged. ✅
- IV (one API): nothing for apps to call; status warning for an unserved claim uses the existing warnings list. ✅
- V (breaking, visible): protocol `/3` in CHANGELOG. ✅
- Doc-sync: `docs/next/concepts.md` (the channel), `docs/contributors/*` touched modules. ✅

## Order

1. ranges.js with lengths (unit tests), encodings `keys.lengths`, PROTOCOL `/3`, `/2` told apart.
2. directory entries without cores: `open/release/use/get/has`, cached length, close after idle, close on space close.
3. Every `log.core` use moved (T024 inventory groups 1–3).
4. Claims and the heard rule (R3, R4) in directory + replication.
5. `_open` from rows only (R7); helpers hand-off (R6).
6. Perf scenarios, docs, CHANGELOG, ROADMAP.

## Project Structure

```text
lib/ranges.js        entries (key, length): digests and keys messages with lengths
lib/encodings.js     keys message: lengths
lib/directory.js     open/release/use/get/has, idle close, claims, per-peer settled, /3
lib/replication.js   holds open logs only; downloads while behind; unheard() for closed logs
lib/space.js         reads through the directory; _open from rows; budget/inspect from cached sizes
lib/index/indexer.js reads through the directory
lib/activity.js      reads through the directory
lib/helpers.js       open → addCore → sent → release; again when grown
lib/network.js       /2 and /1 told apart
lib/testing.js       idleLogs(hg, ms) for tests
```
