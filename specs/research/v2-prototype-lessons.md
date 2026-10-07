# What the v2 prototype taught us

2026-10-07. The v2 prototype (`require('hypergraph/v2')`, specs 007 and 008, preserved at tag
`v2-chat-prototype` and branch `archive/v2-chat-prototype`) was built to answer one question: can a
community's cost follow what a member reads, not the community's size or age? It answered it on a
chat-shaped workload (channels of messages), without hypergraph's graph layer: no entities beyond
messages, no relations beyond replies, no tags, no queries. This note keeps what it taught us, for
the graph to be rebuilt on the same architecture (spec 010) and for anyone who later wants to evolve
the chat shape on its own.

## The architecture, and why each piece is there

| piece | what it is | the problem it solved (measured) |
|---|---|---|
| **Control log** | one small Autobase per community, written only by staff (owner, admins, mods, keepers): roles, channels, bans, hides, keepers, epochs, redemptions | every member needs the decisions; none needs the content to apply them. Grows with decisions, never with content |
| **Author logs** | each author writes each channel's messages to their own Hypercore (key derived from identity seed + community + channel) | no ordering agreement per message: a v1 context's single indexer applied ~300 msg/s; 100 writers reached ~9,300 msg/s |
| **Time segments** | a channel cut into fixed periods (1 h by default) | reading the latest page touches the newest segment only, whatever the history: 0.22 / 0.27 / 0.25 s at 10k / 1M / 10M messages |
| **Keepers and rosters** | a keeper lists, per segment, who posted and where their messages start (single-writer Hyperbee; authors announce over a Hypercore extension; entries signed by authors) | readers find the authors of a segment without a shared index; several keepers' rosters are merged, forged entries rejected |
| **Deterministic order** | pages merge authors by (claimed time, author key, seq) | every reader shows the same order without agreement |
| **Replication modes** | `all` / `sparse` / `auto` with a byte budget | members hold what they read, or everything, by policy |

## Measured, against v1 (one Windows 10 machine, 16 GB)

| | v1 | v2 |
|---|---|---|
| newcomer, latest 50 messages | 1.7 s, 0.73 MB at 10k (text on relation); 44 s, 36 MB at 100k (text in author logs) | 0.22–0.27 s, 68–143 KB, 10k to 10M |
| channel write throughput | ~300 msg/s (one indexer) | ~9,300 msg/s (100 writers) |
| live arrival p50 / p95 | 24–34 / 40–159 ms | 2–15 / 20–33 ms |
| full holder's disk | ~2–3 KB per item | ~211 B per message |
| silent members | ~70 KB memory each on every applying peer | nothing |
| offline restart, shown page again | 121 ms (after a fix) | 3 ms – 0.7 s |

The gains come from storage and lookup (author logs, segments, rosters, a small control log), not from
dropping features. What v2 lacks (graph layer, queries, editing, v1's identity and networking
conveniences) is absent because the prototype didn't need it to answer its question.

## Things that were wrong at first, and what fixed them

**Reading**

- A page took each author's newest `limit` messages, then kept `limit`: 2,500 blocks for a 50-message
  page. Reading in rounds (each author's next 1, 2, 4... blocks, stopping an author once its oldest is
  older than the page's last) fetches ~148: pages 412 → 68 KB. Scrollback by binary search over each
  author's times instead of walking down: 1.1 MB → 161 KB.
- Following polled rosters every 500 ms: that was the whole idle cost (734 ms CPU, +35 MB per 10 s for
  5 channels). Scanning only when a roster grows or the control log changes: 0 ms, nothing.
- A newcomer's first page came back empty before a roster's length was known: wait (bounded) for an
  unseen roster's length.

**Rosters and keepers**

- 100 authors posting their first message at once: the keeper wrote 2,996 roster entries (copies of
  one announcement passing the "already listed?" check together; each first post re-sending every
  pending announcement). Claim in memory before writing; send only the new announcement: 101 entries,
  p95 1.4 s → 33 ms.
- What still grows with history: Hyperbee writes the path's nodes into every block, so a deeper roster
  means bigger blocks (50 / 83 / 98 blocks of 170 / 311 / 463 B at 10k / 1M / 10M). Logarithmic; a
  roster per segment would flatten it.
- Hyperbee writes its header (and its `metadata`) with the first entry, not at creation: a header that
  names other cores must be written explicitly when the bee is created.
- A Hyperbee range read loads the key of every entry it passes (keys live in their own blocks); one
  `get` per known key is a binary search (30 → 11 blocks).

**Moderation**

- Claimed times can be backdated: a ban by time let a banned author keep posting with old dates. A ban
  records each of the author's logs' lengths and readers cut there. To find logs last listed long ago,
  each keeper keeps an author index (author → latest entry) that only mods read.
- In a private channel, plain text appended by anyone was shown: only sealed messages count there.

**Replication and availability**

- Budgets must count what storing costs, not content: each block ~130 B beyond its bytes (Merkle
  nodes, bitfield, keys). Counting content, a 50 MB budget took 125 MB of disk.
- Opening and closing an active session on a log makes Hypercore signal every peer of that log when
  its "in use" state flips: a host's pass over ~1,000 logs cost each connected member 350 KB and 0.5 s
  CPU per 10 idle seconds. Use inactive sessions to plan and check; an active one only to download.
- Downloads could hang at 0 peers after a serving peer opened and closed its sessions (trigger not
  isolated): detect a stall (5 s, no peer) and retry with fresh sessions after ~10 s.
- A segment planned while its logs were out of reach was cached as empty and never fetched: unknown
  lengths are not final.
- Corestore offers every core a peer holds open to each new connection (~87 B each): a host with many
  live logs pays it once per connection.
- RocksDB holds recent writes in native memory (~5.5 KB per small write, up to 2 × 64 MB); flushing when
  quiet made a real member worse, not better.
- No shared index means no need for a separate local database: offline pages come back from the blocks
  a peer holds (3 ms).

**Privacy (spec 008)**

- Grants kept by keepers, looked up only by their recipient: 3.4 / 10 / 23.4 KB at 10 / 1,000 / 50,000
  members, once the identity index moved to its own core (in the same tree it doubled the entries a
  lookup walks).
- Concurrent rotations: grants must be keyed by (recipient, epoch, key commitment), or the keeper keeps
  a losing rotation's key in the only slot.
- A key arriving doesn't make a message readable if nobody online holds its blocks: data availability
  is its own problem (specs/research/availability.md).

**Control log**

- Two events per channel (channel, keeper) cost members ~20–40 MB more at 500 channels: create-and-keep
  in one event.
- The control state must follow the log by itself (Autobase `update` events), or followers miss new
  keepers until the app calls `update()`.
- Every wait for peers needs a bound: a reader of data nobody holds waited forever in `update()`.

## Ideas worth keeping for the graph on v2

1. Per-author logs for everything an author writes (entities, content, relations, tags), not one shared
   indexed log per context: throughput and partial holding come from here.
2. A small staff-written control log for decisions only (roles, permissions, moderation, keys,
   redemptions).
3. Listing by keepers, per time segment, signed by authors: how a reader finds what exists without a
   global index.
4. Deterministic merge order and cuts by log length: no agreement needed, nothing trusts claimed times.
5. Reads that fetch about what they show (rounds, binary search), followers that react instead of poll.
6. Budgets in stored bytes; inactive sessions for bookkeeping; bounded waits everywhere.

## Where the chat shape is worth keeping as its own data type

Its measured advantages hold for high-volume, time-ordered streams with many writers: chat rooms, live
comment threads, activity feeds, logs. A graph can use it as a data type next to entities and relations
(a "stream" or "channel" kind), the way Redis offers several data types.
