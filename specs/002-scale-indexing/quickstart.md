# Quickstart: Validating Scale Indexing

## Prerequisites

- `npm install` in this repo (adds `index-encoder`).
- 16 GB RAM machine for the 1M run; ~20 GB free disk for it.
- HyperBBS and hyperDNS checked out next to this repo, linked by `file:../hypergraph`.

## 1. Nothing regressed

```bash
npm test
```

Every existing suite passes, with the context-view suites running against both index layouts
(see `data-model.md`, "Layout interface").

```bash
cd ../HyperBBS && npm test
cd ../hyperDNS && npm test
```

Both pass with no change to their code (SC-008).

## 2. Feature tests

| scenario | where | proves |
|---|---|---|
| bulk write ≡ single writes | `test/brittle/core/bulk-write.js` | FR-007–FR-010, FR-013 |
| refs inside a batch, ids returned | `test/brittle/core/bulk-write.js` | FR-008 |
| invalid op rejects whole batch, nothing written | `test/brittle/core/bulk-write.js` | FR-009 |
| partial failure reports what was written | `test/brittle/core/bulk-write.js` | FR-012 |
| oplog bytes identical, old vs new append path | `test/brittle/core/event-encoding.js` | FR-021 |
| one bulk call = one replay step on another peer | `test/brittle/replication/bulk-replay.js` | US2 #4 |
| crash mid-indexing → identical index after restart | `test/brittle/core/view.js` | FR-003, SC-007 |
| progress visible during a long pass | `test/brittle/core/view.js` | FR-004 |
| layout 2 queries ≡ layout 1 queries | `test/brittle/core/index-layout.js` | FR-018, SC-006 |
| old-format GraphView rebuilt on open; rollback-safe | `test/brittle/core/index-upgrade.js` | FR-019, FR-020 |
| pre-existing context view keeps layout 1, new one gets 2 | `test/brittle/core/index-upgrade.js` | R8 |
| content index points at log; missing block → null | `test/brittle/core/content-encryption.js`, `view.js` | FR-016 |
| concurrent bulk writers converge | `test/brittle/replication/concurrent-writes.js` | Principle I |
| hostile giant batch / malformed events don't crash | `test/brittle/replication/bulk-replay.js` | edge cases |

## 3. Scale measurements

```bash
node bench/scale.js 100000          # bulk path (default)
node bench/scale.js 1000 --api      # single-item path, for comparison
node bench/scale.js 1000000         # SC-005, ~30+ min
```

Expected at 100,000 entries, against the 2026-10-04 baseline in `spec.md`:

| measure | baseline | target |
|---|---|---|
| write (bulk) | 9.2 min | ≤ 1.5 min (SC-002) |
| fresh peer join | 10.3 min | ≤ 2.6 min (SC-001) |
| retained memory, joining peer | ~400 MB | ≤ 100 MB (SC-003) |
| index bytes per entry | ~2.5 KB | ≤ 0.85 KB (SC-004) |
| disk per member | ~0.93 GB | ≤ 0.47 GB (SC-004) |

The benchmark prints index bytes per structure (FR-023). Record final numbers in
`bench/README.md` with the machine description.
