# Spec 032: seed handler (everyone who reads a site helps keep it online)

**Created**: 2026-11-25 · **From**: the "everyone is a seeder" goal of HyperBrowser, grilled with the owner and the
lead reviewer · **Status**: draft, for review · **Facts**: [research.md](research.md)

## Why

Today a visitor seeds a public site only while its tab is open, plus 5 minutes. Then HyperBrowser leaves the space
(`engine/index.js` `leaveLater`): its records are purged and its cached files are no longer served. A device
announces at most 32 topics, ranked pinned > own > recent (`lib/network.js` `rank`), with no notion of rarity. So
a small site whose owner is offline vanishes, even though dozens of people read it last week.

032 keeps visited sites as **cached sites** and spends a device's announce slots and cache on the rarest ones. No
users yet: breaking changes, no migrations.

## Decided already (constraints)

1. Scope: public sites people visit, plus kept, pinned and owned sites and spaces. Circle holding (024) is
   untouched; its own rarest-first (`lib/circles.js` `rarest`) stays separate.
2. Rarity has two levels, both estimates:
   - per site: a DHT lookup counting announcers, every 30 min per cached site, spread out, paused while a site
     is being opened;
   - per file: each seeder tells peers connected in the site's space which of the site's files it holds (a
     bitmap over the site's file list), on connect and on change. No DHT cost. Counts are among connected peers.
3. Announce slots: kept, pinned and owned first, always. Visited sites fill the rest, fewest seeders first, 0
   seeders before all. A site with 20 or more seeders gives up its slot.
4. A visited site isn't left 5 min after its tab closes. It stays as a cached site: joined, records kept,
   serving only the files in the cache. It is left when its last cached file is evicted. Eviction drops files
   of well-seeded sites first, rare ones last. Visitors fetch only what they read, plus "rare fill" (5).
5. Rare fill: visitors also fetch rare files they never read. Budget: 5% of the cache (50 MB of 1 GB). Only
   files that 0 or 1 connected peers hold, only for sites this device announces. Evicted before files read.
6. Keepers (owners, kept sites, helpers) download a site's files rarest first.
7. Phone, battery or metered network: no rare fill. The rest is unchanged.
8. Privacy: no off switch. A one-time notice per identity, the first time a visited site is seeded (FR-021).
9. Split: hypergraph does the announce ranking (a score per space) and the per-site DHT count. SwarmFS does
   per-file bitmaps, rarity-aware eviction, rare fill, keepers rarest first. HyperBrowser does cached sites, the
   notice and its docs.

## User stories

**US1: a site stays online after its readers close it** (P1)

- Given Alice publishes a site and goes offline, and Dave read it yesterday and closed the tab,
  when Eve opens the site's link,
  then Eve gets its pages from Dave's device, which still holds them as a cached site.
- Given Dave's cache is full of other sites' files,
  when the last cached file of Alice's site is evicted,
  then Dave's device leaves the site (records purged, topic left).

**US2: rare sites get the slots** (P1)

- Given Dave's device caches 40 sites and has room to announce 16 (32 topics),
  when slots are handed out,
  then his own, pinned and kept sites come first, then the cached sites with the fewest seeders, a site with 0
  other seeders before all.
- Given a cached site has 20 or more seeders,
  then Dave's device doesn't announce it; it still serves it to peers already connected.

**US3: rare files survive** (P2)

- Given Dave announces a site and one of its files is held by no connected peer,
  when his device has room in its 50 MB rare-fill budget and isn't on battery or a metered network,
  then it fetches that file though Dave never read it, and evicts it before any file he read.
- Given the cache is full,
  when a file must go,
  then a file of a site with many seeders goes before a file of a rare one.

**US4: keepers fetch the rarest first** (P2)

- Given Carol keeps a site of 1,000 files and two other keepers hold half each,
  when Carol's device fetches the site,
  then it asks first for the files the fewest connected peers hold.

**US5: the reader knows** (P1)

- Given Dave never saw the notice,
  when his device first seeds a site he visited,
  then HyperBrowser shows once, for that identity: "Sites you read are shared from this computer: peers can see
  your IP next to them."

## Requirements

**Announce ranking (hypergraph)**

- **FR-001** The announce ranking takes a **score per top space**, set by the app. Order: pinned, own and
  app-kept first (as today, plus app-kept); then the others by score, lowest first; ties by most recently used.
  Today `lib/network.js` `rank`/`below` and `lib/index.js` `seedRank` each rank by pinned/own/recent; both use
  the new order, so the seeded set (open spaces) and the announced topics agree.
- **FR-002** The score of a space with no app score is its **seeder count** (FR-004). 0 sorts before all. A space
  with 20 or more seeders is **not announced** and not in the seeded set, unless pinned, own or app-kept. It
  still looks up peers while in use.
- **FR-003** A sub-space takes its top space's place in the order (a site's pages ride with the site), as
  `#reseed` does today. Re-ranking runs when a score or count changes; a topic moved out of the slots goes to
  look-only (`refresh({ server: false })`), as `#announce` does today.
- **FR-004** **Per-site seeder count**: for each joined top space not pinned, own or app-kept, a DHT lookup of
  its topic counts the distinct announcers other than this device. Every 30 min per space, spread evenly over
  the 30 min, one lookup at a time through the topic queue. Paused while a space is being joined `now` (a site
  being opened), resumed after. A topic this device announces takes its count from Hyperswarm's own refresh
  when that refresh reports peers, with no extra lookup.
- **FR-005** The count is exposed, read only: `space.seeders` → `{ count, at }` (null before the first count).
  `count` is capped at 20 (a DHT node returns at most 20 announcers). A `seeders` event fires on change.
  `hg.setScore(key, score | null)` sets or clears the app's score (FR-001); `hg.setKept(key, on)` marks a space
  app-kept. Names are tentative (open question 3).
- **FR-006** DHT use by FR-004 stays under **5% of the DHT budget** (80 requests per 750 ms) with 200 cached
  sites (FR-024).
- **FR-007** On a phone the cap stays 8 topics. The desktop cap is chosen from FR-023's results.

**Cached sites (HyperBrowser)**

- **FR-008** Closing a visited site's last tab no longer schedules a leave. The site stays joined as a **cached
  site**: records kept, files served from the cache only. `leaveLater` and `GRACE` go. `sweep` no longer
  leaves visited sites at start.
- **FR-009** A cached site is left (`sfs.leave`) when its last file in the cache is evicted (FR-013 tells the
  engine). A kept, owned, administered, bundled or app-instance site is never left by this (`hosted`, as today).
- **FR-010** HyperBrowser sets `hg.setKept` for kept, bundled and app-instance sites and lets hypergraph rank
  the rest by seeders. Pinned and own spaces need nothing (hypergraph knows them).

**Files (SwarmFS)**

- **FR-011** **Per-file bitmap**: for each site held here, a device sends, to each peer connected in that site's
  space, a bitmap over the site's file list (uploads and pages, in a stable order both sides compute from the
  records) saying which files it holds. Sent on connect and on change (a file cached, kept or evicted), at most
  once per second per site per peer. Over the member streams `transfer.js` already uses; nothing goes on the DHT.
- **FR-012** From the bitmaps, a device knows per file how many connected peers hold it. An estimate: it sees
  only connected peers (Hyperswarm keeps at most 64 connections).
- **FR-013** **Eviction** (`_evict`) drops, in order: rare-fill files (FR-015); then files of sites with the most
  seeders (FR-004), within a site the files the most connected peers hold; least recently read breaks ties.
  It reports a site whose last cached file went (FR-009).
- **FR-014** Visitors fetch only what they read (as `_bytes` does today), plus rare fill.
- **FR-015** **Rare fill**: a visitor fetches files it never read, up to 5% of `appStorageMax` (50 MB of 1 GB).
  Only files that 0 or 1 connected peers hold, only of sites this device announces. A rare-fill file read by the
  person becomes an ordinary cached file. Rare fill stops when the budget is full, and frees room by FR-013.
- **FR-016** Rare fill is off on a phone, on battery, or on a metered network. The app says which
  (`SwarmFS.open({ rareFill })` and a setter; names tentative). Everything else is unchanged on those devices.
- **FR-017** **Keepers rarest first**: `Site#_keep` fetches the files the fewest connected peers hold first,
  ties at random (so keepers starting together spread out). swarmwire's rarest-first inside a file is unchanged.
- **FR-018** Files of a cached site keep being served to visitors through `transfer.js` as today (a visitor is a
  member of a public space; see research.md). No change to the member check.

**What already holds, stated so tests keep it**

- **FR-019** A non-member is never served: private sites and banned identities stay out (`roleOf`).
- **FR-020** Circle holding (`lib/holding.js`) is untouched: its announces stay outside the cap, its rarest-first
  stays its own.

**Privacy (HyperBrowser)**

- **FR-021** The first time a device seeds a visited site for an identity (the site goes into the announced set,
  or serves a file to a peer), HyperBrowser shows once per identity: "Sites you read are shared from this
  computer: peers can see your IP next to them." Once Tor identities exist it adds: "For sites you don't want
  linked to you, use a Tor identity." Seen is recorded in the identity's settings, so it follows the identity
  across devices and shows once in all.
- **FR-022** There is no setting to stop seeding visited sites.

**Perf scenarios** (`npm run perf`, in hypergraph unless noted)

- **FR-023** Announce cap at 32, 64 and 128 topics on a desktop: time to open a site while the device announces
  that many, DHT requests per minute, memory of the open spaces, connections used. The desktop cap is picked from
  the results (and `maxOpen` follows it). Phones stay at 8.
- **FR-024** Per-site counts: 200 cached sites, DHT requests used by FR-004 per minute, as a share of the 80 per
  750 ms budget. Must stay under 5%. Also: requests per lookup, measured.
- **FR-025** Bitmaps (SwarmFS): sites of 100, 1,000 and 10,000 files, with 5 and 50 peers: bytes sent on connect,
  per change, and CPU time to recount a site.

**Every change**

- **FR-026** Each part lands with its docs (`docs/next/api.md`, `docs/next/concepts.md`, SwarmFS and HyperBrowser
  docs), regression tests, and the forum scenario tests updated (`test/next/forum/`). A breaking change gets a
  `CHANGELOG.md` entry.

## Success criteria

- **SC-001** A site whose owner is offline is still readable by a newcomer when one past visitor is online, any
  time until that visitor's cache evicts it (today: only within 5 min of the visitor's tab closing).
- **SC-002** On a device with more cached sites than slots, every announced visited site has fewer seeders than
  every visited site left out (counts at the last lookup).
- **SC-003** In a swarm of 10 visitors and one rare file (held by 1), after rare fill runs, at least 2 devices
  hold it.
- **SC-004** A keeper joining a site where every file is held by one peer each finishes with no file left at 0
  copies if a holder leaves midway (rarest fetched first).
- **SC-005** FR-024: under 5% of the DHT budget with 200 cached sites.
- **SC-006** Opening a site is no slower with 200 cached sites than with none (median, within 10%).

## Tests

- hypergraph `test/next/unit/`: ranking order (pinned, own, kept, then 0 seeders, fewer, 20+ out), sub-spaces
  ride with their top space, `seedRank` and `rank` agree. A fake DHT count for the 30 min schedule and the pause
  while a space opens.
- hypergraph `test/next/net/`: three devices on the local DHT, counts seen, a 20-seeder site drops out of the
  announced set, a 0-seeder site takes its place.
- Forum scenario: a visitor reads a public board, closes it, the owner goes offline, a newcomer reads the board
  from the visitor.
- SwarmFS: bitmap exchange on connect and change, eviction order, rare fill budget and stop on battery, keepers
  rarest first, a site left when its last cached file is evicted.
- HyperBrowser: closing the last tab doesn't leave; the notice shows once per identity.

## Out of scope

- Tor-only identities (next spec: no DHT, onion addresses only, nothing leaves before Tor is connected).
- Helpers taking up rare sites they never saw.
- Circles and their holding (024).
- An off switch for seeding visited sites.

## Open questions

1. **Slots count topics, not sites.** The cap counts every joined space, sub-spaces included, so 32 slots are
   about 16 sites (site + pages). FR-001 to FR-003 keep counting topics. Should the cap count top spaces instead
   (and the perf runs size it that way)?
2. **A cached forum's records are not in the 1 GB cache.** A busy forum's record list is never dropped: about 50
   to 70 MB at 100,000 records (research.md). Its pages are a few small files, rarely evicted, so by decision 4 it
   stays joined a long time. With many such forums the records, not the file cache, are the real cost. Cap the
   number or bytes of cached sites, or leave a cached site whose records pass a size?
3. **API shape in hypergraph.** "A score per space" leaves open who computes it. The spec has hypergraph rank by
   its own seeder count, with an app score and an app-kept flag on top (`setScore`, `setKept`). Simpler: only
   `setKept`, no app score at all. Which?
4. **"Don't announce me" branch.** An unmerged branch adds `announce: false` / `setAnnounce`. That is an off
   switch for all seeding, which decision 8 rules out for visited sites. Keep it (it covers own spaces too) or
   drop it?
5. **64 connections.** Hyperswarm keeps at most 64 connections in total. The bitmap perf scenario asks for 50
   peers in one site, and 128 announced topics share the same 64. Raise `maxPeers` as part of FR-023, or accept
   that counts see few peers?
6. **Who knows "phone, battery, metered".** HyperBrowser is desktop only (Electron) and nothing sets the phone cap
   of 8 today. Electron has a battery API; a metered-network flag on Windows needs a native call. Ship rare fill
   off only on battery for now?
7. **Cached sites outside the slots** are joined but closed: not online, records not updated. They serve nobody
   until they rank back in. Is that the intended "cached site", or should a cached site stay look-only online?
8. **Notice timing.** "Seeded" is either "announced" or "served a file". Announcing can happen in the background
   while the person reads something else. The spec takes whichever comes first; the shell needs a place to show
   it when no tab of that site is open.
