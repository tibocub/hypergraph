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
