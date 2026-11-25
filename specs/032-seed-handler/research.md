# Spec 032 research: what the code does today

Facts checked in hypergraph, SwarmFS and HyperBrowser before writing the spec. Code is cited by file and
function.

## Announcing (hypergraph)

- Two rankings use the same cap, `maxAnnounced` (default 32, `lib/index.js` `MAX_ANNOUNCED`):
  - `lib/index.js` `#reseed` / `seedRank`: the **seeded set**, the top spaces kept open. Order: pinned or circle
    (0), own (1), others (2), then most recently used. Sub-spaces ride with their top space.
  - `lib/network.js` `#announce` / `rank` / `below`: which **topics** are announced. Order: pinned (1), own (2),
    others (3), then most recently used. Circle spaces get no special rank here. A topic past the cap only looks
    for peers. When an announced topic is dropped, `#drop` promotes the best one left.
- The network cap counts **topics, not top spaces**. Every joined space is a topic, sub-spaces included. A site
  is at least two topics (the site space and its pages sub-space), so 32 slots announce about 16 sites.
- Nothing sets 8 on a phone. The JSDoc says "8 suits a phone"; HyperBrowser's engine calls `SwarmFS.open`
  without `maxAnnounced`, and SwarmFS doesn't pass it on.
- `GRACE_MS` (5 min): a closed space's topic is kept that long. A space outside the seeded set closes once idle
  (`_touch`), and its topic goes after the grace. So a joined space outside the seeded set is held on disk but
  not online.
- `maxOpen` is 64 spaces. An open space costs about 250 KB of memory plus 18 KB per open log (`OPEN_BYTES`,
  `LOG_BYTES`). A cap of 128 sites means about 256 open spaces: `maxOpen` has to follow the cap.
- Circle holding (`lib/holding.js` `#join`) announces held spaces outside the topic queue and outside the cap.
  It has its own rarest-first (`lib/circles.js` `rarest`, by copies online).

## DHT limits

- dht-rpc sends at most 80 requests per 750 ms (`lib/io.js` `MAX_WINDOW`, `_drain` every 750 ms): about 106 per
  second, 384,000 an hour.
- A lookup is iterative, 10 requests in flight (dht-rpc `concurrency`). Its exact request count isn't fixed; it
  depends on the routing table. To be measured (FR-024).
- Each DHT node answers a lookup with **at most 20 announcers** for a topic (hyperdht `lib/persistent.js`
  `_lookupReply`, `records.get(k, 20)`). Above about 20, a count is a floor, not a number. The "20 or more seeders
  gives up its slot" rule sits right at what can be measured.
- Hyperswarm refreshes each announced topic every 10 min (`lib/peer-discovery.js` `REFRESH_INTERVAL`). An
  announce runs a lookup first, so announced topics already get announcer lists for free. Only cached sites
  outside the slots need a lookup of their own.
- Hyperswarm keeps at most **64 connections** in total (`MAX_PEERS`), shared by every topic. "50 peers in one
  site" and "200 cached sites" both run into it. Per-file counts (decision 2) count connected peers, so they
  can't see more than that.

## Visitors and leaving

- **A visitor can be served by another visitor today.** In a public space, `roleOf` (`lib/decisions/state.js`)
  gives every identity that isn't banned the role `member`. So `isMember` is true for visitors, `Space#mayRead`
  passes, and `memberConnections()` lists every peer whose channel proved an identity (`Directory#onHello`).
  SwarmFS `lib/transfer.js` serves files to those streams. SwarmFS `test/site.test.js` "a public site: strangers
  read it by its link, the owner offline, from another visitor" checks it. Nothing has to change for 032 here.
- What a visitor holds of a forum: the list of records is never dropped. That's about 0.5 KB per record plus
  about 0.2 KB per app index entry or tag (`docs/next/concepts.md` "Holding part of a space",
  `lib/storage.js` `ROW_OVERHEAD`, `BLOCK_OVERHEAD`). Content past the space's budget share is dropped oldest
  first. A space with over 2,000 records is read newest first (`lib/space.js` `BIG`). Example: a forum of
  100,000 records keeps about 50 to 70 MB of list on every visitor, plus content up to its share of the 5 GB
  app budget. This sits in hypergraph's budget, not in SwarmFS's 1 GB file cache.
- `leaveSpace` (`lib/index.js`) closes the space and its sub-spaces, leaves their topics, marks them left, and
  `#purge` clears the blocks of every log (keeping block 0 of this device's own two logs) and deletes their index
  rows. Log trees and the decision log stay (a shortcut until Hypercore's purge works).
- After `leaveSpace`, cached files of that site stay on disk in SwarmFS app storage. They are no longer served:
  `transfer.js` serves a file only for a space held here.
- HyperBrowser `engine/index.js`: `closeSite` calls `leaveLater`. After `GRACE` (5 min) it leaves the site unless
  `hosted` (an app instance, bundled, kept, or the person is owner or admin). `sweep` at start leaves visited
  sites left over from older versions.

## Files (SwarmFS)

- `lib/swarmfs.js` `_bytes`: a file a visitor reads is fetched into app storage, then `_evict` runs.
- `_evict`: least recently read first, over the files directly in app storage (`appStorageMax`, 1 GB by
  default). Kept files (`appStorage/kept`) don't count and are never evicted.
- `lib/site.js` `Site#_keep`: keepers (owner, kept site) fetch the site's files in record order, one by one.
- swarmwire `lib/select.js`: rarest-first among the pieces of one file, by how many source peers hold each.
  Nothing orders whole files by rarity.
- Files go only over hypergraph's member streams; nothing about files is announced on the DHT.
