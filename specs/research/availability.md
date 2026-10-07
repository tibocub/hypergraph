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
