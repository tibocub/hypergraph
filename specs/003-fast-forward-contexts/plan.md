# Implementation Plan: Fast-Forward Joins, Indexer Topology and App Validation Rules

**Branch**: `003-fast-forward-contexts` | **Date**: 2026-10-05 | **Spec**: [spec.md](./spec.md)

## Summary

Contexts created from now on are **version 2**: the creator is the sole indexer, writers added
later write without indexing, indexers ack automatically, and joining peers fast-forward to the
creator-signed state instead of replaying history. A `context/init` event records the version and
the app's rules id in the context's own log, so every peer applies it identically. Apps attach
`rules = { id, validate(event, reader) }`, which run in apply and reject events before they are
indexed. Measured: a 100k-entry context joins in 0.85 s / 325 MB instead of 132 s / ~3 GB.

Delivered in two phases. **Phase 1 (this plan's tasks)**: US1 for single-indexer contexts, US2,
US3. **Phase 2 (later)**: appointing more indexers (FR-003/FR-006) and converting version 1
contexts (US4 #2) — both need permission checks in apply to be deterministic across peers, which
they are not today (research R4).

## Technical Context

**Language/Version**: Node.js, CommonJS.

**Primary Dependencies**: autobase 7.28 (`ackInterval`, `fastForward`, `host.addWriter({ indexer })`,
`host.interrupt`), hyperbee, hypercore. No new dependency.

**Storage**: context oplog gains one `context/init` event per new context; context view gains
`meta:context`.

**Testing**: brittle; in-memory replication for determinism; `bench/scale.js` for SC-001/002.

**Project Type**: Library.

**Performance Goals**: SC-001 (1M join, first listing ≤ 30 s), SC-002 (≤ 500 MB at 100k, flat to
1M), SC-003 (confirmed ≤ 10 s after writers stop).

**Constraints**: event wire format grows by one event type (encodings tier, test-first); mixed
hypergraph versions within one context unsupported (documented); HyperBBS and hyperDNS green.

## Constitution Check

### I. Correctness Under Concurrency & Partition — PASS with deferral

Every new apply decision is derived from the log: the version and rules id come from
`context/init` (accepted only from the bootstrap writer, only once), indexer flags from that
version, app rules from the event and the apply batch only. The pre-existing non-determinism of
role checks (R4) is harmless with a single indexer and is the explicit reason multi-indexer
appointment is deferred. Partition: writes keep applying locally; confirmation resumes when the
indexer is reachable. Adversarial input: rules that throw reject, malformed `context/init` from a
non-bootstrap writer is ignored.

### II. Test-First — PASS

New event type (encodings), apply changes (context-base) are in the non-negotiable tier; every
task has a failing test first (quickstart §2).

### III. Thin Composition — PASS

Uses Autobase's own indexer flag, acks, fast-forward and interrupt; nothing reimplemented.

### IV. One Coherent API Surface — PASS

Options on the existing `createContext` / `openContext`; one new `context.status()`.

### V. Explicit Breaking Changes — PASS

CHANGELOG entry: new contexts make added writers non-indexers; acks and fast-forward are now on;
mixed versions in one context unsupported; new event type.

### Doc-sync

`docs/contexts-and-roles.md` (topology, trust model), `docs/contributors/autobase-integration.md`
(config, `context/init`), `docs/contributors/event-encoding.md` (new type),
`docs/storage-model.md` (joins), `docs/networking.md` (what joining downloads), README.

## Project Structure

```text
src/encodings/event.js      context/init type
src/context-base.js         init record, indexer flag by version, acks/FF config, rules, reader, status()
src/hypergraph.js           createContext/openContext options, init append, rules mismatch on open
src/tuning.js               ACK_INTERVAL
test/brittle/core/context-rules.js            NEW
test/brittle/replication/indexers.js          NEW
test/brittle/replication/fast-forward.js      NEW
test/brittle/core/{event-encoding,contexts}.js extended
bench/scale.js              join reports fast-forward
```

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|---|---|---|
| Mixed hypergraph versions in one context unsupported | Indexer flags must be decided identically on every peer; an older peer would make writers indexers | Making the topology depend on local configuration instead of the log would let peers silently diverge |
