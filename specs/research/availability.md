# Availability: keeping a community's data online while members come and go

Research note, 2026-10-07, before a spec. Context: hypergraph v2 (`require('hypergraph/v2')`), where
each member already chooses `replicate: 'all' | 'sparse' | 'auto'` with a disk budget (spec 007). The
goal now (Tibo): usable, resilient apps. Small communities must not lose data to members being
offline; big public ones must stay available without every member holding everything, and without
being easy to abuse.

## What blind peering is (read in the source and measured, not assumed)

Packages: `blind-peer` 3.15.1 (the server), `blind-peering` 2.10.0 (the client), `blind-peer-cli`.

- **A blind peer is a server someone runs.** It keeps the Hypercores it is asked to keep, downloads
  each one completely and follows it live, and can't read them (it stores blocks). Default cap:
  `maxBytes` 100 GB.
- **The client talks to a configured list of servers**: `new BlindPeering(dht, store, { blindPeers:
  [{ key, group }] })`. There is **no automatic discovery and no spreading over ordinary peers**:
  members don't become blind peers by joining a swarm.
- **Redundancy is per core**: `addCore(core)` / `addAutobase(base)` send it to the `pick` (default 2)
  servers closest to the core's key by XOR distance, preferring different `group`s. Every client with
  the same list picks the same servers for a core, so readers find what authors handed over.
- **No chunking or erasure coding across servers.** A core goes whole to its 2 servers. (Hypercore
  itself already downloads a core's blocks from every connected peer holding them, in parallel; v2's
  per-author, per-channel logs are already small units. RAID-style coding would need blocks that
  aren't Hypercore blocks: not available.)
- **Eviction is whole cores, lowest priority and oldest first**, once over `maxBytes`. Clients that
  aren't trusted get priority ≤ 1; the server's operator lists trusted client keys (priority 2,
  `announce` to the DHT, deleting cores). Cleared blocks are **never fetched again** (the server
  remembers how far it cleared).
- **Reading through a blind peer is plain replication**: the client dials the server and runs
  `store.replicate(stream)`; any core the server holds then flows like from any other peer. Idle
  connections are closed after a few seconds; adding a core (cheap if already there) reconnects.

## Experiments (`bench/v2-blind.js`, `bench/v2-blind-gc.js`; local DHT, one machine)

| | result |
|---|---|
| author posts 200 messages, hands its control log, roster and log to one blind peer, leaves | the blind peer holds them 145 ms after being asked |
| a fresh reader, asking the blind peer **only for the control log** | channel list in 67 ms, latest page in 93 ms: roster and log came by plain replication |
| the same reader after 15 s idle, scrolling back to messages it never fetched | 26 ms |
| 2 blind peers, one gone before the reader comes | reads in 65 ms from the other — **but `addAutobase()` waits for every chosen server and hangs while one is down; `addAutobaseBackground()` doesn't** |
| 3 blind peers, one gone | 52 ms (each core was on 2 of the 3) |
| 4 communities (59 KB) handed to a blind peer capped at 40 KB | it cleared ~25 KB: the two oldest communities whole; those two unreadable, the two newest fine |
| the first author comes back with its data and hands it over again | **not restored**: cleared blocks are never re-fetched |
| a reader of an evicted community | **hangs in `community.update()`** (Autobase waits for blocks nobody holds): v2 needs bounded updates |

## What this means for hypergraph

1. **Small communities**: blind peering doesn't replace "everyone keeps everything" unless someone runs
   a blind peer. A **community policy** of full replication stays necessary (and is cheap there).
2. **Transparent reading works** once members are connected to the community's blind peers: data
   arrives through normal replication. What has to be automatic is the rest: every member's client
   knowing the community's blind peers (from the control log), connecting in the background, and the
   cores being handed over (authors their own logs, keepers their channels' logs, rosters and grants,
   everyone the control log).
3. **A full blind peer is a recent cache, not an archive**: it drops whole old communities first and
   never takes them back. Sizing (`maxBytes`), priority (trusted clients) and a hypergraph-aware
   helper matter for anything meant to last.
4. **Blind peers don't know what is rare.** "Keep the rarest pieces" needs something that knows the
   community's structure and who holds what: a hypergraph-aware **helper** (a member in `all` or a
   duty mode, always on, shared with SwarmFS as Tibo has long wanted), or **duty among members**.
5. **Duty among members** (the path that could make full replication unnecessary at scale): each
   member, within its budget, holds the logs and segments assigned to it by XOR distance from its key
   (the same trick blind-peering uses among servers), k copies each, re-assigned as members come and
   go. Needs a churn simulation to size k and budgets against members' online time.
6. **Contribution ("seeding rate") and quotas**, for public communities that resist abuse:
   - enforceable today: **keepers already decide who is listed**, so a per-author byte or message quota
     per segment (by role or tier) stops someone from flooding data they don't host;
   - measurable: what each peer uploads is counted locally by Hypercore (`upload` events), but
     self-reported numbers can't be trusted; **audits** can: ask a member for random blocks of what it
     claims to hold, over a connection to that member only, and check them against the Merkle tree
     (relaying from someone else is the caveat; timing helps);
   - roles by tier (e.g. "gives ≥ 1 GB → may post up to X per day"): granted in the control log by an
     auditor role, from audit results.
7. **Availability reporting**: an app should learn "this segment has 0 known holders online" instead
   of waiting; and every v2 wait (including `update()`) needs a bound.

## Questions this leaves for the specs

- Community policy: which settings, who sets them, and what a member below the policy can still do
  (read only? post within a smaller quota?).
- Helpers: one program for hypergraph and SwarmFS — a v2 member in `all`/duty mode plus, optionally,
  a blind-peer server for other apps; how a community lists them.
- Duty: k, assignment unit (author log per channel, or segment), reaction time to churn — from a
  simulation.
- Contribution: audit protocol, who audits, how tiers become roles, how quotas are enforced by keepers.

## Self-organizing availability: keeping everything online without anyone holding everything

Tibo's goal (for hypergraph and, mostly, SwarmFS at terabyte scale): members give each community a
cache; members organize themselves so every piece stays online, the rarest first, without races,
handling churn as the normal case ("at that scale a disk dies every few seconds" — GFS; here, members
leave every few seconds). Optional always-on helpers (one program for hypergraph and SwarmFS, groups
of them like IPFS Cluster) carry what members can't.

### A blind peer in every client?

Not forbidden, but the package doesn't fit: it is a server (own swarm, database, RPC), keeps whole
cores for anyone who asks (strangers giving orders), picks holders from a fixed list (stale under
churn; every change moves whole cores), evicts whole cores and never re-fetches them. Its placement
rule is the right idea, though, and needs no blind peer: **each member computes on its own which
pieces it should hold** (rendezvous hashing: rank members per piece by hash(member, piece); the top k
hold it), then downloads them with plain Hypercore range downloads.

### The arithmetic first (`node -e` in this note's history; holders online independently)

P(piece available) for a holder online with probability p:

| scheme | storage | p = 0.1 | 0.2 | 0.3 | 0.5 | 0.9 |
|---|---|---|---|---|---|---|
| 3 copies | 3× | 27% | 49% | 66% | 87.5% | 99.9% |
| 10 copies | 10× | 65% | 89% | 97% | 99.9% | >99.9999% |
| RS 10-of-30 | 3× | 0.05% | 6% | 41% | 97.9% | >99.9999% |
| RS 32-of-96 | 3× | 0% | 0.15% | 27% | 99.97% | >99.9999% |

RAID-like coding (Reed–Solomon) beats copies only when holders are online most of the time (servers,
desktops); with casual members (p ≤ 0.3) it is worse than copies. With flaky members, availability
can't come from storing more: it comes from **repairing** (copying to members online now) faster than
holders leave. Hence a simulation.

### Simulation (`bench/sim-availability.js`; 300 members, 1,000 pieces of 4 MB, 3 simulated days)

Casual members online ~1 h, offline ~3 h (25%); helpers online ~95%. Holders keep pieces while
offline. Repairs are coordinated by rank (the best-ranked online non-holders act first, each after its
slot plus random jitter, re-checking before starting).

| policy | availability | repair traffic / member / day | stored / member |
|---|---|---|---|
| eager: keep 3 online | 99.44% | 120 MB | 400 MB (copies pile up: 30 per piece) |
| eager, trimmed to 12 copies | 99.39% | 411 MB (trim, re-copy, trim...) | 160 MB |
| lazy: repair below 2 online, 6 in all | 89.7% | 9 MB | 107 MB |
| lazy: repair below 1 online | 81.7% | 0 (no source left when it's needed) | 80 MB |
| 3 helpers, each piece on 2 of them, members idle | 99.87% | 0 | 27 MB |
| 3 helpers (2 of 3) + members eager 2, trimmed to 8 | **99.98%** | 30 MB | 104 MB |
| 3 helpers (2 of 3) + members lazy | 99.79% | 0.2 MB | 80 MB |
| eager 3, members online 50% | 99.94% | 57 MB | 211 MB |
| eager 3, 1,000 members (same data) | 99.34% | 36 MB | 120 MB |
| eager 3, 64 MB pieces | 99.41% | 1.9 GB | 6.3 GB |

What it says:

1. **Members alone can keep everything ~99.4% available, at a real cost**: every member ends up holding
   a growing share (copies pile up as holders come back) and repair traffic is ~9 piece-copies per
   piece per day. Trimming bounds storage but multiplies traffic.
2. **More members make it cheaper for each**: same data, 3.3× the members → traffic 120 → 36 MB/day,
   storage 400 → 120 MB per member; availability depends on uptime, not headcount.
3. **A few always-on helpers do most of the work cheaply**; members' caches close the gap (99.87% →
   99.98%). This is the classic result (Blake & Rodrigues 2003: churn makes maintenance bandwidth the
   limit; Total Recall, Carbonite: count copies that are offline but coming back, repair late).
4. **Piece size doesn't change availability, only cost granularity**: traffic scales with piece size;
   small pieces spread repairs over many members (no single upload bottleneck) and let caches trim
   finely. For SwarmFS: pieces as block ranges of a file's Hypercore (e.g. 4 MB), verified block by
   block by its Merkle tree, fetched from every holder in parallel.
5. **Races**: rank plus jitter still made ~18% duplicate copies in the simulation (announcement
   latency); uncoordinated copying (everyone who notices) is the worst case to avoid. Holders should
   announce a repair when they start it, not when they finish.

### How peers learn what is rare, at scale (design sketch, not measured yet)

- **Who holds what**: HyperDHT is already a Kademlia DHT. Group pieces into shards (e.g. 2^b of them by
  piece key prefix); a member announces on the topics of the shards it holds; a lookup of a shard's
  topic returns its current holders: a decentralized tracker. Announcing per shard, not per piece,
  keeps DHT traffic bounded.
- **Who repairs**: rendezvous rank among online members (from shard lookups and connections), the
  best-ranked first, slot + jitter, announce on start.
- **Within a budget**: each member's cache per community; past it, it drops its lowest-ranked pieces
  (they rank someone else first).
- **Helpers**: members with a helper role and a large or unlimited cache; a helper group gets a
  replication factor (each piece on r of the group's h helpers: 2 of 3 = each holds 2/3), ranked
  among helpers only. Erasure coding fits there (high uptime): RS 2-of-3 over 3 helpers stores 1.5×
  instead of 2× for the same "one may fail". Parity as its own author-signed Hypercore keeps every
  piece verifiable.

### Names (to choose)

For the self-organizing cache: *Hivekeep*, *Commons*, *Seedbank*, *Hyperhive*. For the always-on
helper program shared with SwarmFS: *Anchor*, *Lighthouse*, *Steward*, *Hivekeeper*.

### Clarified (Tibo, 2026-10-07)

- **No parity.** "RAID-like" meant chunks kept a configurable number of times (2–3 by default);
  repairing = copying a chunk from one of its remaining holders. That is what the simulation models
  (the Reed–Solomon rows above are only for comparison).
- **Rarity counts every holder**, not only cache duty: readers holding a chunk, full replicas,
  helpers. A file seeded by 30 people is not a helper's priority.

### Network-wide lookups by root (SwarmFS, mostly)

SwarmFS already addresses files by Merkle root (fixed 1 MB chunks, verified per chunk) and finds peers
by Hyperswarm topic. HyperDHT is already one global DHT shared by every Holepunch app. A network-wide
"who has root X" is an announce/lookup on a topic derived from X.

Measured (`bench/dht-latency.js`, public HyperDHT, 5 trials, 2026-10-07):

| | p50 | max |
|---|---|---|
| announce a topic | 1.7 s | 2.2 s |
| look it up (found 5/5) | 1.4 s | 1.6 s |
| look up a topic nobody announced | 1.3 s | 1.6 s |

- **Fast enough** as a fallback ("no seeder in my space for this file"): ~1.5 s once, then chunks
  come from the peers found. Not per chunk.
- **Scalable if announcements are per root, not per chunk**: each holder re-announces what it holds
  as announcements expire; a peer with 10,000 public roots would announce continuously (IPFS's
  "reprovide" problem; Kubo announces roots only and rate-limits). Rarity inside a file comes from its
  swarm (peers' chunk bitfields), not from the DHT.
- **Safe for integrity** (content addressed: a fake provider wastes time, can't corrupt), **not
  private**: announcing a root tells anyone who looks it up that this IP holds it; lookups show
  interest to DHT nodes on the path. Global announcing must be opt-in (public files/spaces); private
  spaces never announce roots globally.
- **Shared infrastructure**: the public DHT stores announcements on other people's nodes (Keet's
  users among them); how many records it tolerates per announcer is not measured yet.
