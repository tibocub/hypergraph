# Scaling study: what else can make hypergraph viable at archive scale

2026-10-05. Follows `specs/002-scale-indexing/` (batched indexing, `graph.batch()`, first 1M run).
Goal from the request: hypergraph must hold up for HyperBBS forums and for SwarmFS community
archives with millions of entries — so check dependency settings for missed easy wins, sparse
replication, configurable indexes, and compression. Everything here is measured unless marked
as an estimate. Machine: Windows 10, 16 GB RAM, Node 26.4. Benchmarks: `bench/scale.js`,
`bench/multiwriter.js` and `bench/sparse-fetch.js` (the last two in the `perf-experiments`
worktree).

## 1. Where the bytes and the time go now

Per item (one entity + one content reference + one relation, as SwarmFS would store a file),
10,000 items, writer side, current code:

| | blocks | bytes |
|---|---|---|
| user log (entity + content events) | 2 | 440 B |
| context oplog (relation event) | 1 | 350 B |
| GraphView entries `n:`, `nt:`, `nc:`, `c:` | 4 | 1.25 KB |
| context view entries `e:`, `er:`, `i:in:`, `cnt:out:` | 4 | 1.3 KB |
| per-block overhead on disk (~183 B × 11 blocks) | — | 2.0 KB |
| **total** | **11** | **~5.4 KB** |

The per-block overhead is the surprise: Merkle tree nodes, RocksDB keys and filters cost more
per item than all the index payloads of either view. **The number of blocks per item matters as
much as their size.** (`docs/storage-model.md` used to say "2-3x raw data"; measured, it is ~5x
for small items. Corrected.)

Time: writing is ~1.4 ms per item with `graph.batch()`; a joining peer replays a context at
~1 ms per relation (signature check 8%, per-read snapshot sessions ~9%, Autobase bookkeeping
~5%, the rest disk and hashing — no easy win left inside that loop). At 1M items the join fails
in Autobase's final view commit (R11 in the spec's research).

## 2. Dependency settings checked

| setting | where | effect measured | verdict |
|---|---|---|---|
| Hyperbee `sessions: false` | GraphView | folder listing 366 → 284 ms (−22%); write and join unchanged | **done** — safe because GraphView is never truncated; context views keep snapshots (Autobase truncates them) |
| Hyperbee `alwaysDuplicate: false` | both views | no change | not worth it |
| Hypercore `inflightRange` [256, 4096] | remote user cores | log download 13.0 → 8.4 s at 50k; join total unchanged (replay dominates) | worth enabling only once replay stops dominating (fast-forward) |
| `INDEX_BATCH`, `PREFETCH_WINDOW` | hypergraph | flat across 250–4,000 / 1,024–16,384 | defaults fine |
| Autobase `ackInterval` | contexts | 3-writer context: 0 → **0 of 24,013 view blocks ever confirmed**; 1,000 ms → all confirmed, convergence 23 → 31 s | **must change for multi-writer contexts** — part of the fast-forward design |
| Autobase `fastForward` | contexts | 20k join 17.2 s / 826 MB → **1.2 s / 288 MB**; listings fetch index blocks on demand (~0.9 s for 1,000 entries on localhost) | **the big one** — needs the trust design (section 4) |
| Hyperbee peer extension | views | on by default; lets a sparse reader resolve a lookup in one round trip | already on |
| Hypercore mark & sweep (`startMarking` / `sweep`) | any core | not measured | the eviction tool for a sparse cache (section 4) |
| RocksDB compression | storage | **off**: store files shrink to 25–29% under gzip/zstd; rocksdb-native exposes no compression option | see section 3 |

## 3. Compression

**RocksDB does not compress anything today**, and neither hypercore-storage nor rocksdb-native
offers a way to turn it on. A gzip/zstd pass over the store files shrinks them 3.5–4x — but most
of what gzip finds is structural redundancy hypergraph can remove itself, and the per-block
overhead (section 1) is not compressible by us at all.

What hypergraph can do without touching dependencies, estimated per item:

| step | per item | how |
|---|---|---|
| today | 5.4 KB | |
| compact index layout (spec 002 P2) | ~3.6 KB | binary keys, no derivable values, content index points at the log |
| + "lean" index profile (section 5) | ~2.8 KB | drop `nt:`, `nc:`, `cnt:out:` (3 fewer blocks) |
| + compact event format (wire change) | ~2.4 KB | binary keys in events, drop fields that must equal the core's own key |

So ~2.25x smaller is reachable inside hypergraph. Compressing values ourselves would add little
on top: index values become a few bytes, and events are already compact-encoded once keys are
binary; per-value compression of ~100-byte values gains little without shared dictionaries, and
zlib is not available on Bare.

**One dependency change would clear your bar** (useful to every user, opt-in, nothing removed,
not breaking): exposing RocksDB's compression option in rocksdb-native's `ColumnFamily`
(default unchanged), and passing it through hypercore-storage/Corestore. Worth a proposal later,
not a blocker.

## 4. Sparse replication

Today, opening a context replays all of it and opening a user core downloads all of it. A
**sparse mode** — peers keep only what they read — is feasible with what the dependencies
already provide:

| piece | provided by | status |
|---|---|---|
| context index without replay, fetched on demand | Autobase fast-forward + Hyperbee on a sparse core (+ peer extension) | measured: works, 1.2 s join at 20k |
| an entity by id | the id is `<type>/<author>/<seq>`: one `core.get(seq)` on the author's log | trivial |
| many entities at once (a listing) | `core.download({ blocks: [...] })` | measured: 1,000 scattered blocks of a 200,000-block log in 92 ms, holding ~0.9 MB instead of 60 MB |
| evicting what is no longer needed | Hypercore mark & sweep / `clear()` | available, unmeasured |

What sparse mode cannot keep, and the design question each raises:

1. **Global indexes over everything** (`getByType`, `query()` chronological, `getByAuthor`)
   need every entity indexed somewhere. In sparse mode they would only cover what this peer
   has read. Either they are documented as "what you have", or the context carries the indexes
   an app needs (contexts are where sparse reads work well).
2. **Latest content of an entity**: the `c:` index is what finds the newest content version;
   without it, a sparse reader cannot know where in the author's log the content is. For
   SwarmFS this argues for putting what a listing needs (name, hash, size) **in the context**,
   next to the relation, so a folder listing is a context read and nothing else. That is a data
   model choice for SwarmFS, and possibly an extension of what a relation can carry (today only
   a numeric `value`).
3. **Deletions**: a tombstone is a later event in the author's log; a sparse reader would not
   see it. If removal is expressed in the context (unrelate), sparse readers see it.

Sparse mode depends on fast-forward, so it comes after it.

## 5. Configurable indexes ("profiles")

Each index entry costs a block (~183 B overhead + payload) on every peer that builds it.
What each one buys:

| index | per item today | used by | if dropped |
|---|---|---|---|
| `n:` | 1 block, 307 B | `get()`, every listing's node lookup | required |
| `c:` | 1 block, 577 B (body copy) | `getContent()` | required (pointer form in P2: ~45 B) |
| `nt:` | 1 block, 183 B | `getByType()`, `query().type()` | type queries unavailable |
| `nc:` | 1 block, 178 B | `query()` default chronological order | global timeline unavailable |
| `e:` | 1 block, 461 B | `edges(out)` | required |
| `i:in:` | 1 block, 348 B | `edges(in)` (folder listings) | required |
| `er:` | 1 block, 329 B | duplicate check, `unrelate()` | required |
| `cnt:out:` | 1 block, 96 B | `countEdgesOut()` | could count by scanning (out-degree is usually small) |
| `cnt:in:` | once per chunk | `countEdgesIn()` | keep |

A **"lean" profile** (no `nt:`, `nc:`, `cnt:out:`) saves 3 of 11 blocks per item (~27%) for apps
that never ask for a global timeline — likely SwarmFS. A **"full" profile** stays the default
for HyperBBS. A profile has to be fixed per view when it is created (switching later means a
rebuild, like any format change), which fits the per-view layout record already planned in
spec 002 P2. Because context views would become shared under fast-forward, a context's profile
would then be part of the context, chosen by whoever creates it.

## 6. Bigger structural ideas (not measured, for later)

- **Fewer blocks by grouping entries.** Hyperbee stores one entry per block, so the 183 B
  overhead is paid per entry. Storing a folder's children in pages (one entry per page of
  entries) would cut blocks by orders of magnitude for bulk-written folders, at the cost of
  read-modify-write on single additions. This is the in-graph version of the "manifest blob"
  idea for SwarmFS, and could be layered on top rather than built into the core.
- **SwarmFS manifest blobs** (your option from the start): an immutable large folder as one
  content-addressed manifest moved by swarmwire, one entity in hypergraph. With fast-forward and
  sparse reads, plain per-file entities become viable too; manifests remain the cheapest for
  very large, rarely changing folders.

## 7. Recommended order

Status (2026-10-05): **1 is done for single-indexer contexts** (spec 003 phase 1: acks,
creator-only indexing, fast-forward, app rules); multi-indexer appointment is phase 2. **3 is
done differently from planned**: rather than lazily loading users' logs, a relation can carry
signed data (spec 004), so listings never need the logs — a 1M-entry archive is browsable 1.2 s
after joining with 60 MB on disk. GraphView `sessions: false` is done. 2 and 4 remain.

1. **Fast-forward + indexer topology + acks + app validation hook**, one spec: the only path to
   1M joins, the fix for unconfirmed multi-writer contexts, and the natural home of your
   validation-hook ask (rules run on indexers, which is what every fast-forwarding member
   trusts). Decision needed from you on who indexes.
2. **Spec 002 P2 (compact layout), extended with index profiles**: ~33% smaller now, ~48%
   with the lean profile; designed so a context's layout/profile is fixed at creation, ready
   for shared views.
3. **Sparse mode**, on top of 1 and 2, with SwarmFS's listing data living in the context.
4. **Compact event format** (wire change, one coordinated break) and the rocksdb-native
   compression proposal, when the above has settled.

## 8. Docs corrected in this pass

Checked every top-level and contributor doc against the code. Fixed:

- `storage-model.md`: "2-3x raw data" → measured table; relation/tag/moderation data is in the
  context views, not duplicated into GraphView; what Autobase actually keeps per peer.
- `local data distribution.md`: same overhead claim; tags *are* indexed; `getByAuthor()` is the
  unindexed query; the "storage is cheap" conclusion revisited.
- `contributors/index-structure.md`: indexes live in two kinds of Hyperbee, not one; tags are
  indexed; real checkpoint keys (`meta:contextView:…:length`); missing `msg:`, `m:p:`, `w:p:`;
  full `n:` value; counters per chunk.
- `querying.md`: tags are indexed; what `getByAuthor()` costs.
- `glossary.md`: GraphView does not index relations/tags.
- `contributors/critical-implementation-details.md`: relations **are** ownership-checked on
  `from` at apply time (the doc said the opposite).
- `networking.md`, `contributors/replication-flow.md`: DHT announcement is about finding peers,
  not about data created before it; "selective replication" is about which peers you connect
  to, while what you download is what you open.
- `contributors/component-details.md`, `contributors/event-encoding.md`: `batch()`, GraphView
  `sessions: false`, pre-encoded context values.
