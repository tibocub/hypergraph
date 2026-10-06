# Benchmarks

## `scale.js` — one context with N file entries

```bash
node bench/scale.js <N> [--api] [--sizes]
```

Models a SwarmFS file index: per file one `entity/create` and one content reference in the
author's user core, and one relation `file --in--> dir` in a context, with folders of 1,000.
Three processes, so each peer's memory is its own: a writer, a seeder that reopens the writer's
store, and a fresh peer that replicates and indexes everything over a localhost socket.

| flag | effect |
|---|---|
| (none) | writes in bulk |
| `--api` | writes one file at a time through `put` / `putContentRef` / `relate` |
| `--sizes` | adds bytes per core and per index prefix (count, key bytes, value bytes) |
| `KEEP=1` env | keeps the temporary stores and prints where |

Raw JSON results go to `bench/results/` (gitignored: they describe one machine on one day).
Summaries worth keeping go below, with the machine they came from.

## Results

Machine for every row unless noted: Windows 10, 16 GB RAM, Node 26.4.

### 2026-10-04 — baseline, before `specs/002-scale-indexing`

| files | write | fresh peer joins | list 1,000-entry folder | disk per peer | peak memory, joining peer | memory held after |
|---|---|---|---|---|---|---|
| 1,000 | 4.9 s | 5.4 s | ~170 ms | ~40 MB | 0.46 GB | — |
| 10,000 | 49 s | 52 s | ~250 ms | ~111 MB | 1.0 GB | — |
| 100,000 | 9.2 min | 10.3 min | ~400 ms | 0.93–1.0 GB | 3.7 GB | ~400 MB |

`--api` at 1,000 files: 7.3 s (138 files/s).

Logical bytes per file at 10,000 files: global view indexes ~1.25 KB, context view indexes
~1.3 KB, author's log ~440 B, context log ~350 B. A fresh peer's context replay made one apply
call per relation (10,063 at 10k).

### 2026-10-04 — `specs/002-scale-indexing` P1 (batched indexing, `graph.batch()`)

| files | write (`graph.batch()`) | fresh peer joins | list 1,000-entry folder | disk writer / joiner | peak memory, joining peer | memory held after |
|---|---|---|---|---|---|---|
| 10,000 | 7.2 s | 12.4 s | ~340 ms | 58 / 75 MB | 0.6 GB | 33 MB |
| 100,000 | 71 s | 132 s | ~450 ms | 564 / 706 MB | 3.1 GB | 88 MB |

A fresh peer's context replay now makes one apply call per bulk call (100 at 100k, was one per
relation). The joining peer's memory peak is a transient spike inside Autobase at the end of
context catch-up, unaffected by hypergraph's batch sizes; see
`specs/002-scale-indexing/research.md` R10. `MEMLOG=1` prints the timeline, `FETCH_ONLY=ctx|log`
replicates one half of the index, `HEAPSNAP=<MB>` writes a heap snapshot past that heap size,
`HG_INDEX_BATCH` / `HG_PREFETCH_WINDOW` override the defaults.

### 2026-10-04 — first 1,000,000-file run (P1 code)

- **Writer**: completed in ~15.8 min (other experiments were running on the machine at the
  same time, so this is pessimistic), memory flat at ~650–900 MB RSS throughout. Its store was
  then deleted by the benchmark's own cleanup before the summary was saved (since fixed: each
  phase is saved as it finishes, and stores are kept when anything fails).
- **Fresh peer**: replayed the entire context — 2,000 Autobase batches, ~5 million context-view
  blocks — in ~21 min with memory flat at ~650–750 MB, while streaming the author's 2-million-block
  log alongside. Then, in the final commit of the replayed view, the JavaScript heap went from
  ~200 MB to the 8 GB limit within seconds and the process died (`Reached heap limit`).

That final commit is Autobase/Hypercore committing the whole replayed view at once
(`specs/002-scale-indexing/research.md` R11). It cannot be avoided from hypergraph while every
joiner rebuilds the view itself; fast-forward (research R13) is what removes it.

### 2026-10-05 — `specs/003-fast-forward-contexts` (acks, creator-only indexing, fast-forward)

| files | write | first folder listable on a fresh peer | fresh peer fully indexed | peak memory, fresh peer | fresh peer disk |
|---|---|---|---|---|---|
| 20,000 | — | 0.5 s | 9.2 s | — | — |
| 100,000 | 62 s | — | 48 s (was 132 s) | 689 MB (was 3.1 GB) | 304 MB (was 706 MB) |
| **1,000,000** | 11.3 min, 912 MB peak, 5.25 GB disk | **10.3 s** | **11.4 min** (was: crashed after ~21 min) | **751 MB** | 2.58 GB |

The fresh peer fast-forwards the context (one fast-forward, 2 apply calls at 1M) and fetches
index blocks only when reading: a 1,000-entry folder listing takes ~1.7 s on first read at 1M.
What remains of a full join is downloading and indexing the author's whole log (2 million blocks
at 1M) for the global view — the part a sparse user-core mode would remove.

### 2026-10-05 — `specs/004-relation-data` (`--edge-data`: listing data on relations)

The writer also puts `{ name, root, size }` on each file's relation; the fresh peer opens **only
the context** and lists from edge data, never opening the author's log.

| 1,000,000 files | full join (spec 003) | context only, edge data (spec 004) |
|---|---|---|
| first folder listable | 10.3 s | **1.2 s** |
| join complete | 11.4 min | **1.4 s** |
| peak memory, fresh peer | 751 MB | **329 MB** |
| fresh peer disk (after 6 listings) | 2.58 GB | **60 MB** |
| 1,000-entry listing with names | ~1.7 s | **~0.66 s** |

Writer: 10.8 min, 913 MB peak, 5.5 GB disk (edge data adds ~0.25 GB at 1M).

### 2026-10-05 — `specs/002-scale-indexing` US3 (compact index keys)

GraphView in `graph-view/2` with binary keys and content as pointers; new contexts' edges,
counters and tags in layout 2 (`docs/contributors/index-structure.md`). Disk is measured after
`compact()` on each store: uncompacted sizes swing by tens of percent with whatever RocksDB has
not flushed yet (one joining peer: 50 MB uncompacted, 22 MB compacted).

| | before | after |
|---|---|---|
| 10k: GraphView / context view, logical | 12.9 / 12.9 MB | 2.6 / 4.0 MB |
| 10k: disk writer / joiner | 51.3 / 34.8 MB | 31.7 / 18.6 MB |
| 100k: GraphView / context view, logical | 130.8 / 130.1 MB | 26.9 / 41.1 MB |
| 100k: disk writer / joiner | 520 / 260 MB | 322 / 149 MB |
| 100k: write / full join | 56.7 / 42.3 s | 53.2 / 39.0 s |
| 100k: 1,000-entry listing, writer / joiner | 330 / 712 ms | 402 / 806 ms |

**1,000,000 files** (full join, no edge data; "before" is the spec 003 row above):

| | before | after |
|---|---|---|
| write | 11.3 min, 912 MB peak | **9.2 min**, 977 MB peak |
| writer disk | 5.25 GB | **3.26 GB** |
| first folder listable on a fresh peer | 10.3 s | **2.5 s** |
| fresh peer fully indexed | 11.4 min | **8.8 min** |
| peak memory, fresh peer | 751 MB | 855 MB |
| fresh peer disk | 2.58 GB | **1.46 GB** |
| 1,000-entry listing on the fresh peer | ~1.7 s | ~0.9 s |

Listings are ~15% slower at 100k on a peer that holds everything (content is read back from the
author's log), and faster on a fresh 1M peer (fewer, smaller index blocks to fetch). "First folder
listable" depends mostly on when Autobase fast-forwards: measured 2.5–3.3 s at 10k on both the old
and the new code, with an occasional 0.4 s run.

## Chat and many-channel benchmarks (2026-10-06)

Usage-shaped benchmarks for the scaling-v2 research (`specs/research/scaling-v2.md`, which has
the full tables and what they mean).

```
node bench/chat.js <N> [--writers W] [--model edge|content] [--live M]
node --expose-gc bench/channels.js <C> [--messages M] [--authors A]
```

- `chat.js`: one channel, W writers, N short messages (text on the relation, or entity + content
  + relation). Reports write rate, live arrival between two members, and for a fresh peer: time
  and bytes to the latest 50 messages, the oldest page, memory, disk, and a cold reopen offline
  and online. `CHATLOG=1` traces each phase.
- `channels.js`: one member with C channels open. Reports idle `update()` cost, live arrival,
  memory, cold reopen.

Headline numbers:

| | result |
|---|---|
| newcomer, latest page, text on relation, 10k → 100k messages | 1.9 s → 1.2 s, 0.7 MB both (flat) |
| newcomer, latest page, text in author logs, 10k → 100k | 5.5 s → 44 s, 4.2 → 36 MB (grows) |
| idle `update()`, 10 → 200 open channels | 8 → 121 ms (grows) |
| memory per open channel | ~3 MB |
| offline reopen after showing the latest page (100k, edge) | stuck |
