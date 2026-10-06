# Scaling v2: cost proportional to what a peer holds

**Status**: research, 2026-10-06. Not a spec yet. Measurements: `bench/chat.js`,
`bench/channels.js` (results at the end).

## The goal, in one sentence

Opening, reading and writing in a community should cost the same whether its history holds 10
entries or 100 million: **cost follows what a peer holds and reads, not how old or big the
community is.** "Infinitely scalable" then means: nobody has to hold everything; what is available
is what someone online (a member or a helper server) still holds.

## Diagnosis: where the cost comes from today

Specs 002–006 made the existing design about 3–7× cheaper per entry, but four design choices
still make cost grow with history:

1. **One context is one history that grows forever.** Every event since the context was created
   is in one Autobase: one ordered log, one view. Indexers process all of it; the view never
   shrinks; there is no "old part" a peer can leave behind.
2. **Everything goes through order agreement.** Posts, replies, votes and messages are all
   ordered by the indexers. Only membership, roles and moderation need one agreed order;
   a message needs an author, a time and a place.
3. **The global index wants each author's whole log.** GraphView indexes every opened user core
   from seq 0. The 8.8 min "full join" at 1M (`bench/README.md`) is a newcomer downloading and
   indexing all 2M entries of the author's log. With relation data and the context alone, the
   same 1M join is 1.2 s / 60 MB (spec 004): the cost is in the "replicate everything" path.
4. **Every index entry is a permanent, signed log block** (~183 B overhead on disk each, never
   deleted). GraphView is a private cache and does not need to be a log.

## What comparable systems do

| system | approach | lesson for hypergraph |
|---|---|---|
| IRC | servers keep no history | live chat works without history |
| Matrix | full room history; joining large rooms was notoriously slow; added lazy loading of members and "sliding sync" (sync only what the client shows) | same wall; fixed by syncing the visible window |
| Discord | messages stored by channel and time bucket | partition by time so "recent" stays small |
| Nostr | per-author signed events kept by relays; clients query "kind, since, until, limit"; no shared order | messages need no order agreement; reads are time-window queries |
| Bluesky (AT Protocol) | per-user signed repositories; separate indexing services (AppViews) build feeds | separate data (per author) from indexes (built by whoever needs them) |
| Secure Scuttlebutt | replicated full feeds of everyone followed; onboarding took hours and GBs; moved to partial replication | the "replicate everything" trap |
| Willow / Earthstar | entries addressed by subspace (author), path and time; sync only an area of interest; a newer entry can delete everything under its path | partial sync and forgetting built into the data model |

Already in the Holepunch stack:
- **blind-peer / blind-peering**: servers that keep Hypercores and Autobases available (the
  "availability helpers" a community would run).
- **HyperDB**: an indexed database that runs either on Hyperbee (shared) or on plain local
  RocksDB (local only), the right home for private indexes.
- **hyperbee2**: a rewrite of Hyperbee, "scalable P2P BTree", in progress.
- Hypercore is natively sparse: a peer can hold any subset of a log.

## Goals

1. **Flat cost.** Time to the latest page, memory, and per-message write/apply cost stay flat
   from 10k to 100M entries. Disk equals what the peer chose to keep.
2. **Nothing grows forever in one piece.** Contexts become a chain of time segments (per period
   or per N events). Old segments are closed, fetched only on scrollback, and can be dropped.
3. **Order agreement only where needed.** A small control log per community (members, roles,
   moderation, list of segments) that every member keeps in full. Content lives in authors' signed
   logs plus small per-segment indexes.
4. **Local indexes in a local database** (deletable, compactable, no log overhead). Shared
   indexes only per segment, to make joining fast.
5. **Replication is a setting, `auto` by default.**
   - `replicate: 'all'` — hold everything (small communities: availability matters more than
     disk; everyone is a backup).
   - `replicate: 'sparse'` — hold what you read, plus a recent window (large communities).
   - `replicate: 'auto'` (default) — hold everything while the community's projected size per
     member fits a disk budget (configurable, e.g. a share of free disk or a fixed MB), switch to
     sparse (keeping the most recent part that fits) when it doesn't. Decided per community from
     sizes the peer can see (segment lengths and byte lengths), re-evaluated as it grows.
6. **Forgetting is a feature.** Per-peer retention (e.g. keep 30 days); "available" = held by
   someone online; communities run blind peers with longer retention for what matters.
7. **Moderation works on partial data.** Bans, hides and roles live in the control log, which is
   always complete, so a peer holding only today's messages still applies them.
8. **Offline-first holds.** What a peer has shown must stay readable offline after a restart
   (today it doesn't; see findings).
9. **The easy API stays.** `put`, `relate`, `query`, invites keep working; segments, retention
   and replication mode are options with sensible defaults.

## Measuring before redesigning

New benchmark `bench/chat.js` (one channel, W writers, N short messages; two message models:
text on the relation, or entity + content + relation). It reports, per history size:
write rate, live arrival time between two members, a newcomer's time and bytes to the latest
page, the oldest page, memory, disk, and cold reopen offline and online.

Planned next: many contexts per peer (a community with hundreds of channels), many writers per
context (10 → 100+), a forum shape (threads, replies, votes), and a long-running peer's growth.

### Findings so far (2026-10-06, Windows 10, 16 GB, one machine)

**Chat channel** (`bench/chat.js`, 10 writers, owner is the only indexer, ~85-byte messages):

| | 10k edge | 100k edge | 10k content | 100k content |
|---|---|---|---|---|
| newcomer: latest 50 messages shown | 1.9 s | 1.2 s | 5.5 s | **44 s** |
| newcomer: bytes downloaded by then | 0.73 MB | 0.71 MB | 4.2 MB | **36 MB** |
| newcomer: disk / peak memory | 5 MB / 192 MB | 5 MB / 139 MB | 20 MB / 261 MB | 128 MB / 363 MB |
| newcomer: oldest page | 49 ms | 75 ms | 50 ms | 66 ms |
| newcomer: cold reopen, offline | 151 ms | **stuck** | 400 ms | 274 ms |
| live: arrival between two members, p50 / p95 | 24 / 52 ms | 24 / 40 ms | 31 / 97 ms | 28 / 38 ms |
| holder of everything (owner): disk | 41 MB | 215 MB | 30 MB | 307 MB |
| owner: reopen | 0.5 s | 0.8 s | 0.2 s | 1.0 s |

("edge" = text on the relation; "content" = entity + content + relation, text in the author's log.)

**1M messages** (edge model, 2 writers, 21 min to write at ~780 messages/s): newcomer shows the
latest page in **1.5 s after downloading 0.74 MB** (170 MB memory, 13 MB disk); oldest page 119 ms;
offline reopen **stuck** again; the owner holding everything: 2.36 GB on disk, 1.5 s to reopen.
(Live arrival is not meaningful in this run: with 2 writers the receiver is the sender.) So with
the text on the relation, a newcomer's cost is flat from 10k to 1M.

**Many channels** (`bench/channels.js`, one member owning C channels of 200 messages):

| channels | 10 | 50 | 200 |
|---|---|---|---|
| idle `update()` (nothing new), p50 | 8 ms | 34 ms | **121 ms** |
| live arrival in one channel, p50 | 17 ms | 44 ms | **138 ms** |
| memory with all open | 173 MB | 282 MB | **625 MB** |
| cold reopen of all channels | 0.4 s | 1.1 s | 4.3 s |
| first page after reopen | 22 ms | 12 ms | 14 ms |

**Many members** (`bench/members.js`, one channel, M members added as writers who never write,
200 messages):

| members | 10 | 100 | 1,000 | 5,000 |
|---|---|---|---|---|
| owner: idle `update()` for this one channel | 0.8 ms | 1.2 ms | 8 ms | **39 ms** |
| owner: memory | 99 MB | 115 MB | 253 MB | **447 MB** |
| newcomer: latest page | 0.43 s | 0.49 s | 0.46 s | 0.45 s |
| newcomer: bytes | 0.17 MB | 0.25 MB | 0.33 MB | 0.34 MB |
| adding one member | 7 ms | 5 ms | 5 ms | 5 ms |

**What this says**

1. **Reading recent messages is already flat when the text is on the relation**: same time and
   bytes at 10k, 100k and 1M (fast-forward + lazy blocks). The design direction holds; the defaults
   don't use it.
2. **Text in authors' logs makes a newcomer's cost grow with history** (×8 time, ×9 bytes from 10k
   to 100k): GraphView indexes each opened author log from the start. This is how most apps write
   today (`put` + `putContent` + `relate`).
3. **Idle cost grows with the number of open channels** (~0.6 ms per channel per `update()`, and
   live messages wait for it): every `update()` asks every context for news, re-reads its full
   member list, and scans its moderation queue, whether anything arrived or not. The member-list
   re-read also grows with members.
4. **Memory ~3 MB per open channel**: a member of 1,000 channels would need ~3 GB.
5. **A full holder pays ~2–3 KB of disk per message** (215 MB at 100k, so ~200 GB at 100M): fine for
   a helper server, not for every phone. Hence `replicate: 'auto'`.
6. **Offline reopen can lose the latest page** (100k edge): the page was shown, then after a restart
   with no peer it never loaded. The view's newest root had moved on after the read and was never
   downloaded. Violates goal 8.
7. **Live arrival is fine at chat scale** when few channels are open (p50 ~25 ms, p95 < 100 ms).
8. **Members cost memory and idle time even when silent**: ~70 KB of memory per member on a peer
   that applies the context, and every `update()` re-reads the whole member list (39 ms at 5,000
   members, for one channel). A 50,000-member community would need ~3.5 GB on every applying peer.
   A newcomer is unaffected (0.45 s, 0.34 MB at 5,000).
9. **One indexer caps a channel's write rate.** With each writer in its own process (2026-10-06):
   10 writers post 1,000 messages each in 6–8 s, but the owner, the only indexer, applies
   everyone's messages at ~300/s while serving 9 peers, so 10k messages take 33.5 s to be in. (The
   earlier ~120–140/s was 10 in-process writers sharing one core.) A busy channel needs its
   apply work spread, which the v2 per-segment indexes would allow.

### Quick fixes applied (2026-10-06, on the current design)

| finding | fix | after |
|---|---|---|
| 3. idle cost grows with open channels | `update()` touches only what changed; members re-read only on change; moderation queue scanned only when non-empty | 200 channels: idle `update()` 121 → 0.8 ms, live arrival 138 → 13 ms, memory 625 → 348 MB |
| 8. member list re-read each update | same | 5,000 members: idle `update()` 39 → 0 ms (memory per member unchanged: it's Autobase's) |
| 6. offline reopen stuck | a context's index layout remembered locally; control records prefetched when the view grows | 100k chat: offline reopen stuck → 121 ms |

Found on the way: once an idle `update()` did no I/O, an app polling it in a tight loop starved
replication (live messages stalled until something else wrote to disk). `update()` now yields to
the event loop once.

Still open from the findings: text in authors' logs (2), memory per channel and per member (4, 8),
full-holder disk (5): these need the v2 design.

Still to measure: a
forum shape (threads, votes), a long-running peer's growth, many writers on separate machines.

### v2 prototype measured (2026-10-06, `specs/007-scaling-v2-prototype`)

Summary against v1 (details below and in the tables above):

| | v1 | v2 |
|---|---|---|
| newcomer, latest 50 messages | 1.7 s, 0.73 MB at 10k (edge); 44 s, 36 MB at 100k (content) | 0.61 / 0.69 / 0.67 s, 412 / 455 / 490 KB at 10k / 1M / 10M |
| channel write throughput | ~300 msg/s (one indexer) | ~9,300 msg/s posted by 100 writers, all delivered |
| live arrival p50 / p95 | 24–34 / 40–159 ms | 2–14 / 20–23 ms |
| full holder's disk | ~2–3 KB per message | ~211 B per message |
| silent members | ~70 KB memory each, every applying peer | nothing |
| idle, followed channels | 0.8 ms per `update()` at 200 channels (after fixes) | 0 ms CPU, 0 bytes per 10 s |
| offline restart, shown page | 121 ms (after a fix) | 3 ms – 0.7 s |

`bench/v2-chat.js`: one channel, history written in bulk (10,000 messages per one-hour segment,
50 active authors per segment out of 1,000), served by the owner, who keeps the roster. A fresh
peer then reads it. Same machine as above; one run at a time, 3–4 processes.

| | 10k | 1M | 10M |
|---|---|---|---|
| newcomer: latest 50 messages shown | 0.61 s | 0.69 s | 0.67 s |
| newcomer: bytes downloaded by then | 412 KB | 455 KB | 490 KB |
| newcomer: memory added | 36 MB | 37 MB | 37 MB |
| newcomer: author logs open | 50 | 50 | 50 |
| newcomer: one page back (previous segment) | — (one segment) | 1.2 s / 1.1 MB | 1.1 s / 1.0 MB |
| newcomer: restart offline, page shown again | 173 ms | 247 ms | 426 ms |
| newcomer: disk | 11 MB | 42 MB | 40 MB |
| host holding everything: disk | 2.4 MB | 218 MB | 2.1 GB |
| host: disk per message | 237 B | 218 B | 211 B |
| host: reopen | 117 ms | 374 ms | 870 ms |

v1 for the same shape (above, 10k, 10 writers): latest page 1.7 s / 0.73 MB; full holder ~2.4 KB
per message; 1M newcomer full join 8.8 min.

Throughput (`--writers 100 --procs 2 --seconds 10`, 10k history, one follower):

| | 100 writers, 5 msg/s each | 100 writers, as fast as they can |
|---|---|---|
| posted | 476 msg/s | 9,300 msg/s |
| delivered to the follower | 100% (486 msg/s) | 100% (6,700 msg/s: the follower is the limit) |
| arrival p50 / p95, authors already known | 14 / 20 ms | 4.6 / 9.3 s (backlog) |
| arrival p95, including each author's first posts | 1.4 s | — |

v1: one indexer applies ~300 msg/s for the whole channel.

Against the spec's success criteria:

- **SC-001** (same 2 s budget, memory and download within 10% at every size): time and memory
  pass. **Download misses: +19% from 10k to 10M** (412 → 490 KB). Two candidates, both
  logarithmic, neither measured yet: each author log is ~50× longer, so each block's proof
  covers a deeper tree; and the roster holds 1,000 segments instead of one, so reaching the
  latest segment reads more Hyperbee nodes.
- **SC-002** (under 2 MB for 50 messages from 50 authors): pass, 0.49 MB.
- **SC-003** (≥ 5× v1's ~300 msg/s with 100 writers): pass, ~30× posted; one follower reads
  ~22× v1.
- **SC-004** (p50 < 100 ms, p95 < 500 ms): p50 2–14 ms, pass. p95 was 511–527 ms at every
  size: an author's first post in a segment waited for the reader's 500 ms roster poll. Fixed:
  `follow()` now re-reads the rosters as soon as one grows (test `v2 reader: follow finds a new
  author when the roster grows`). After the fix: one author posting p95 22 ms; 100 authors at
  5 msg/s p95 20 ms once known. **Still a miss when 100 authors all post for the first time
  in the same second (p95 1.4 s)**: each announcement goes to the keeper, which lists it, and
  the roster then has to replicate to the reader.
- Newcomer disk grows from 11 MB (10k) to ~40 MB (1M, 10M) for the same page: not explained
  yet.

**Community size** (`bench/v2-community.js`, T020): the member opens 5 channels, each with 100
one-hour segments of history, 50 active authors per segment drawn from all members. The other
channels each have a little activity. The host serves from a fresh reopen.

| | 10 ch, 1k members | 10 ch, 50k members | 500 ch, 1k members | 500 ch, 50k members |
|---|---|---|---|---|
| distinct authors in the 5 channels | 1,000 | 25,000 | 1,000 | 25,000 |
| control log events | 43 | 43 | 2,003 | 2,003 |
| startup: control log caught up | 0.36 s, 34 KB | 0.27 s, 34 KB | 0.60 s, 693 KB | 0.64 s, 690 KB |
| 5 channels opened (latest page + follow) | 1.66 s, 516 KB | 1.61 s, 507 KB | 1.55 s, 523 KB | 1.58 s, 510 KB |
| memory with 5 channels open | 59–63 MB | 60 MB | 67–80 MB | 85 MB |
| author logs open | 500 | 500 | 500 | 500 |
| idle, 10 s: CPU / bytes | 0 ms / 0 | 0 ms / 0 | 0–94 ms / 0 | 0 ms / 0 |

(500 logs open: a follow watches the authors of the current and the previous segment, 100 per
channel here.)

- **Member count: no effect.** A member who never posted appears nowhere; 25× more distinct
  authors in the open channels' history changes nothing a reader does now.
- **Channel count: the control log.** Every member holds the channel list in full (by design):
  two events per channel (the channel, its keeper), ~1.4 KB downloaded per channel. At 500
  channels startup is 0.6 s and 0.7 MB, and memory with the same 5 channels open is ~10–35%
  higher (noise between runs is ±10 MB). **SC-005 misses on memory for 10 vs 500 channels.**
  Of the +28 MB right after joining, the JS heap is +2 MB and buffers +0.6 MB; the rest is
  native, RocksDB (a plain Hypercore: 2,000 small appends add 16 MB, 10,000 add 55 MB; its write
  buffer holds up to 2 × 64 MB, not configurable through hypercore-storage). Flushing gives it
  back in that plain test (55.6 → 7.8 MB, 131 ms), but flushing when activity goes quiet made
  the 500-channel member *worse* (idle 74–81 MB against 67–70 MB without, two runs each), so it
  was not kept. Left: fewer control events per channel (one keeper event for many channels),
  Autobase fast-forward for newcomers; both untested.
- **Replication (T023–T024, SC-008)**, `bench/v2-chat.js --replicate auto`: at 10k with the
  default 1 GB budget, a newcomer holds everything (`holding: 'all'`). At 1M (218 MB on the host)
  with a 50 MB budget: a window of the newest ~23 segments, 49.6 MB counted, 50.2 MB downloaded,
  disk 86 MB (a sparse newcomer's store alone is 11–55 MB, mostly RocksDB log files), filled in
  38–57 s while the latest page still showed in 0.6–0.7 s. Budget accounting counts stored bytes
  (block + 130 B), measured against disk. Two faults found by the benchmark and fixed: with the
  host itself on `auto`, some downloads hung with 0 peers (window 13 MB after 515 s; now a stall
  is detected in 5 s and retried with fresh sessions), and segments planned while their logs were
  out of reach were kept as empty and never fetched (regression test). SC-008 holds on these
  runs; reads beyond the window are not counted yet.
- **Fixed on the way**: following channels polled the rosters every 500 ms. Idle with 5
  channels followed: 734 ms CPU and +35 MB per 10 s; now 0 ms and nothing (scan on roster
  growth and on control log change only). Closing a channel releases its logs and rosters
  (`closeChannel`). Serving right after a bulk build, Corestore offered every just-closed core
  to each new connection (~87 B each: 5,032 cores, +170 KB at startup); the benchmark now
  serves from a reopened store, and the same holds for a long-running helper with many cores
  open.

