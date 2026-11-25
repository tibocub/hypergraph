# Spec 035: I2P (hide users' IPs, keep everyone a seeder)

**Created**: 2026-11-25 · **From**: research [033](../033-i2p-research/research.md) and spike 034 (its Q1b), decided
with the owner · **Status**: reviewed, ready to plan · **Covers**: hypergraph, SwarmFS, HyperBrowser

## Why

Every HyperBrowser user is a seeder, so every peer sees their IP next to the sites they read (032's notice says so).
Some people need to read and post without that. Tor was dropped: TCP only, built to reach the normal internet. I2P
is a network of its own where every router relays, it has datagrams, and users join the existing network on day
one. 033 measured: the DHT (`dht-rpc`) and replication work over I2P, slowly. 034: i2pd built by us as a library
passes Windows Defender, where the official binaries were quarantined. No users yet: breaking changes, no migrations.

## Decided already (constraints)

1. **Router: i2pd 3.0.0**, built by us as a statically linked Node-API library (no i2pd exe; 033 Q1b), loaded in
   one small process the shell owns, which outlives identity switches. Every identity's engine connects to it with
   its own SAM session: same computer, same IP, so sharing it costs no privacy, and relaying and tunnels survive
   switches. Every build is scanned by Windows Defender in CI; the release fails if anything is flagged; a flagged
   build gets a free false-positive submission to Microsoft. No paid code signing for now. emissary is the last
   resort only, behind the same SAM seam.
2. **Dual stack**: every desktop install runs the router, started by the shell, invisible to the user. Regular
   identities use the normal network with each other, and I2P only to reach I2P-only peers.
3. **Anonymous identities**: a switch when an identity is created. Their engine contains no Hyperswarm or plain-UDP
   code at all, starts only once I2P tunnels are ready, never falls back. One SAM session per identity, a fresh
   destination every time it opens, 3-hop tunnels set explicitly, never shared with another identity.
4. **Data crosses** between the two halves by replication through dual-stack peers, never by proxying.
5. **Compartmentalization**: an anonymous identity shares no storage and no held files with any other identity
   (SwarmFS identifies files by content). Photo metadata (EXIF) is stripped on upload for anonymous identities.
6. **Threat model**, stated plainly in the user docs: protects against peers, site owners, ISPs and local-network
   observers; not against a global observer or a state targeting one person (timing). One engine runs at a time; a
   warning when the person switches between a regular and an anonymous identity, either way, within 10 minutes of
   the last one closing.
7. **Relaying** on by default with a bandwidth cap. "Don't relay" turns on by itself in I2P's strict countries
   (033), and is a setting.
8. **Reseeding through our peers**: regular identities hand router records to new routers, merged with I2P's
   official reseed.
9. **Every leak in 033 Q7 closed.** The contacts' own Hyperswarm goes through the engine. The updater stays
   app-level on the normal network, as today, and pauses while an anonymous identity is open. The transport seam
   goes in `Hypergraph.open`.
10. **Not yet tested, so the plan's first tasks**: Linux and macOS builds, a Bare host, stop/start cycles in one
    process, a soak run of several days.
11. **Spec 032** (seed handler) applies per engine. Anonymous identities seed over I2P through the same ranking.
12. Every change lands with its docs, regression tests, forum scenario tests and perf scenarios (I2P lookup time,
    join time and throughput as tracked numbers).
13. **Discovery inside I2P** from the first version: `dht-rpc` over SAM repliable datagrams (topic → destination
    records, a pluggable address codec upstreamed to dht-rpc), helpers as its bootstrap nodes. Not helpers-only:
    an anonymous user must reach sites that have no helper.
14. **Anonymous identities seed only while open.** Always online exposes them to online-time matching (033).
    Regular identities carry 24/7 seeding.
15. **The UI says the speed honestly**: I2P suits chat and forums, not media (measured 0.03–0.14 MB/s).

## User stories

**US1: an anonymous identity reads and posts without showing its IP** (P1)

- Given Ana creates an identity with "Anonymous" on,
  when it opens,
  then HyperBrowser shows "Connecting to I2P…" until tunnels are ready, and nothing of the identity touches the
  network before that; no packet of it ever leaves outside I2P.
- Given Ana opens a forum's invite whose space has a helper,
  when she joins and posts,
  then she gets the forum over I2P, her post reaches the other members, and no member, helper or site owner learns
  her IP.
- Given I2P can't be reached (blocked, no tunnels),
  then the identity stays at "Connecting to I2P…" with the reason; it never falls back to the normal network.

**US2: regular users reach anonymous ones, and the other way** (P1)

- Given Bob (regular, dual stack) and Ana (anonymous) are members of the same forum,
  when Ana posts,
  then Bob sees the post, carried by replication over I2P to a dual-stack peer (Bob, a helper or another member),
  then over the normal network to the rest.
- Given Carl (regular) and Bob are both regular,
  then they connect over the normal network as today, not over I2P.

**US3: an anonymous user finds a site with no helper** (P1)

- Given a public site with no helper, announced by one dual-stack seeder, Bob,
  when Ana opens its link,
  then her engine looks the topic up in the DHT inside I2P, finds Bob's destination and replicates the site from
  him.

**US4: nothing links two identities on one machine** (P1)

- Given Ana's machine also holds a regular identity, Dan,
  when Ana opens a file Dan holds,
  then the anonymous identity fetches it over I2P into its own storage; Dan's copy is neither read nor served by it.
- Given Ana uploads a photo,
  then its EXIF data (location, camera, time) is removed before it is stored.
- Given Dan closed less than 10 minutes ago,
  when Ana opens (or Dan opens less than 10 minutes after Ana closed),
  then HyperBrowser warns that the two can be linked by timing.

**US5: everyone relays, at a cost the user doesn't notice** (P2)

- Given a fresh install outside the strict countries,
  then its router relays others' tunnels, capped (FR-023), and the user sees nothing of it.
- Given an install in a strict country, or a user who turned relaying off,
  then the router relays nothing and publishes itself as client-only.

**US6: a new router starts from its peers** (P2)

- Given a fresh install whose user opens a regular identity first,
  when its router starts,
  then it gets router records from several regular peers plus the official reseed, and its first tunnels are
  ready sooner than through the official reseed alone.

## Requirements

**The router (HyperBrowser shell; i2pd library)**

- **FR-001** The shell starts one router process, separate from the engines, that loads i2pd 3.0.0 as a Node-API
  addon built by us (034's `start(dataDir, samPort)` /
  `stop()`), statically linked, one file per platform. SAM listens on 127.0.0.1 only, on a port picked at start.
  No web console, no UPnP or NAT-PMP, no IPv6 unless the host has a route.
- **FR-002** The router process starts with the app and outlives identity switches: switching identities closes
  the old engine's SAM session and opens the new one's, without restarting the router. Its data folder is per
  install, outside every identity's folder. The shell passes the SAM port to each engine it starts.
- **FR-003** CI builds the addon for Windows, Linux and macOS from the signed i2pd tag, scans each Windows build with
  Defender, and fails the release on any detection. A flagged build is submitted to Microsoft as a false positive.
- **FR-004** The shell supervises the router process: a crash or stop is restarted with backoff; while it is down,
  anonymous identities show "Connecting to I2P…" and send nothing; regular identities keep the normal network.
- **FR-005** emissary is a last resort only: engines speak SAM, never i2pd internals, so a router swap touches
  the router process alone. Not built or shipped by this spec.

**The transport seam (hypergraph)**

- **FR-006** `Hypergraph.open(dir, { transport })`: `'normal'` (default; Hyperswarm only, as today), `'dual'`
  (Hyperswarm plus I2P) or `'i2p'` (I2P only), with `sam: { host, port }` for the last two. Passed on to `Network`
  (its `swarm` option exists but nothing sets it today, `lib/index.js:246`). SwarmFS passes it through `SwarmFS.open`.
- **FR-007** With `'i2p'`, hypergraph never loads `hyperswarm`, `hyperdht`, `udx-native` or `blind-pairing`:
  they're required lazily on the other paths only. A test asserts none is in the module cache after an `'i2p'`
  engine has opened, joined, replicated and closed.
- **FR-008** The I2P side is a swarm stand-in with the surface `Network`, helpers and holding use: join a topic
  (announce and/or look up through FR-013), `listen` (accept on the session's destination), `dht.connect(key)` for
  helpers and holders (key → destination), connections as secret-stream over SAM streams (028's `stream-swarm`
  approach), with the device key pair as today.
- **FR-009** One SAM session per opened `Hypergraph`, created with `inbound.length=3 outbound.length=3` and a new
  destination on every open; its private key is never saved. The session is never shared, and is closed at
  `close()`.
- **FR-010** `'i2p'`: `open()` resolves only once the session's tunnels are ready (a `transport` event reports
  progress); before that no space is joined. If SAM is unreachable it keeps retrying; it never falls back.
- **FR-011** `'dual'`: regular peers connect over Hyperswarm as today; the engine also listens on its I2P
  destination and announces its topics in the I2P DHT, so I2P-only peers can reach it. When both paths reach one
  peer, Hyperswarm wins and the I2P connection is dropped.
- **FR-012** Joining over I2P connects before it times out: `redeemInvite`'s 30 s (`JOIN_TIMEOUT`) counts from the
  first connection, not from the call, since an I2P stream takes 5–17 s and 2–3 tries (033 Q3).

**Discovery inside I2P**

- **FR-013** A DHT inside I2P: `dht-rpc` over SAM repliable datagrams, two commands (announce and look up a topic →
  destinations). Records are signed by the announcing destination and expire as hyperdht's do.
- **FR-014** dht-rpc gets a pluggable address codec (address encoding in `lib/peer.js` and the id hash), so an
  address is a 32-byte destination hash. Upstreamed; until merged, a pinned fork. Lookups resolve a hash to a full
  destination with SAM `NAMING LOOKUP` of its `.b32.i2p` name.
- **FR-015** `adaptiveTimeout: { min: 3000, max: 20000 }` (I2P round trips ~1 s, first datagrams often lost).
- **FR-016** Bootstrap nodes are the helpers' I2P destinations: from the invite, from space settings, and a list
  shipped with the app. Helpers listen on I2P too and run DHT nodes there.
- **FR-017** Only dual-stack engines with a long uptime act as DHT nodes holding others' records; anonymous engines
  are clients of it (they don't store records), so their online time isn't exposed as a node's.

**Anonymous identities (HyperBrowser, SwarmFS)**

- **FR-018** Creating an identity offers "Anonymous" (off by default), fixed for the identity's life. It is saved in
  the identity's list entry; its engine opens with `transport: 'i2p'`.
- **FR-019** While an anonymous identity is open, contacts use its I2P session (FR-026), the updater is paused
  (FR-027), `deviceName` is empty
  (today `os.hostname()`, `shell/main.js:1485`), and `--no-guards` is refused while it is open.
- **FR-020** Device pairing (`lib/pairing.js`, DHT-based) is off for anonymous identities: `addDevice` throws
  `NOT_ALLOWED`. Restore by recovery phrase still works.
- **FR-021** Own storage: an anonymous identity's engine folder and Electron partitions are its own (as for every
  identity today), and SwarmFS never serves or reads another identity's files, even with equal content hashes.
- **FR-022** SwarmFS strips EXIF (and the same metadata in PNG and WebP) from images uploaded by an anonymous
  identity before hashing, so the stored file is the stripped one.

**Relaying and reseeding (HyperBrowser router process and engines)**

- **FR-023** Relaying is on by default: i2pd `bandwidth` set to a cap of 256 KB/s (`O`) and `share` 50 %, numbers
  revisited from the soak run (FR-041). A setting turns it off (`notransit = true`).
- **FR-024** "Don't relay" is forced on when the machine's country is in Java I2P's strict list (033), decided by
  the router itself (i2pd's geo-IP), with the list shipped in the addon. The setting then shows why.
- **FR-025** Reseeding: a regular engine publishes its router's current records (100, ~100 KB) in a hypercore of its
  own; a new router merges records from at least 3 unrelated peers with the official reseed servers before its
  first start (`reseed.zipfile`). Records from a single peer are never used alone (eclipse, 033 Q5).

**Leaks (033 Q7)**

- **FR-026** Contacts (`engine/contacts.js:344`) use the engine's network instead of their own `new Hyperswarm`.
  Over `'i2p'` they use the engine's I2P session.
- **FR-027** The updater (`shell/updater.js`) stays one per app, never per identity, with its own Hyperswarm on the
  normal network, as today; it doesn't go through an engine. The shell pauses it (swarm destroyed, no lookups)
  while an anonymous identity is open, and resumes it when a regular identity opens.
- **FR-028** Each of the 14 paths of 033 Q7 gets a regression test or a written reason it is closed by design
  (#8: the router shows the IP runs I2P, not who).
- **FR-029** The warning of decision 6: when the person switches from a regular to an anonymous identity, or back,
  within 10 minutes of the last one closing. Shown before the new identity's engine connects. The time of the last
  close is the shell's, kept in memory.

**Seeding (032 per engine)**

- **FR-030** Anonymous identities seed what they read through 032's ranking, over I2P, only while open; nothing is
  announced from them once closed. Regular identities keep 032 as specified (cached sites, 24/7 while the app runs).
- **FR-031** 032's per-site seeder count works per engine: over the I2P DHT for an `'i2p'` engine, over hyperdht
  for the others (a `'dual'` engine counts both). Same cap of 20, same order.
- **FR-032** 032's notice (FR-021 there) says "For sites you don't want linked to you, use an anonymous identity"
  (it said Tor).

**UI and docs (HyperBrowser)**

- **FR-033** An anonymous identity is marked in the identity list and the window frame.
- **FR-034** The user docs state the threat model of decision 6 in plain words, what "anonymous" doesn't cover
  (timing, a global observer, what they post themselves), and that the router relays.
- **FR-035** The router is invisible: no window, no tray, no console. Its state shows only as "Connecting to I2P…"
  for anonymous identities and in a settings page (relaying, bandwidth).
- **FR-036** When an anonymous identity opens a file over 5 MB, the UI says it will be slow ("I2P suits chat and
  forums; large files take minutes") and shows progress.

**Perf scenarios** (`npm run perf`, real I2P network, tracked over time)

- **FR-037** I2P lookup time (FR-013), median and p95 over 20 lookups.
- **FR-038** Join time of a public space over I2P, first stream to first post.
- **FR-039** Throughput over I2P: post latency and bulk MB/s, 028's scenario.
- **FR-040** Router cost: start to tunnels ready (fresh and with peer records), memory, CPU idle.

**First tasks of the plan (decision 10)**

- **FR-041** Before anything else: the addon built on Linux and macOS; loaded on a Bare host; 20 `stop()`/`start()`
  cycles in one process with no leak or crash; 20 identity switches against one router process, its tunnels and
  transit kept; a scripted soak run of several days (relaying, tunnels, memory,
  restarts). A failure here stops the plan, not the spec: emissary (FR-005) is weighed then.

**Every change**

- **FR-042** Each part lands with its docs (`docs/next/api.md`, `docs/next/concepts.md`, SwarmFS and HyperBrowser
  docs), regression tests, the forum scenario tests (`test/next/forum/`), and FR-037–FR-040. Breaking changes get
  a `CHANGELOG.md` entry. SwarmFS's suite runs after each core change.

## Success criteria

- **SC-001** An `'i2p'` engine opens, joins, replicates and closes with zero packets outside 127.0.0.1 (checked by
  a capture or a socket hook in the test), and no `hyperswarm`/`hyperdht`/`udx-native` loaded.
- **SC-002** A post by an anonymous member reaches a regular member through a dual-stack peer, median under 5 s.
- **SC-003** An anonymous user finds and opens a site with no helper and one dual-stack seeder, median lookup under
  15 s (033 measured 1.3–13.2 s).
- **SC-004** Defender flags no release build; CI fails the release if it does.
- **SC-005** A router started from peer records has tunnels ready faster than one from the official reseed alone
  (median of 5 starts).
- **SC-006** The soak run (FR-041) ends with the router up, memory flat (within 20 %), every crash restarted.
- **SC-007** No two identities on one machine share a destination, a SAM session or a stored file.
- **SC-008** Switching identities never restarts the router: an anonymous identity opened after a switch has its
  tunnels ready in under 15 s (median of 5), against 39 s+ for a router start.

## Tests

- hypergraph `test/next/unit/`: transport option checks, lazy requires (FR-007), the address codec, session options
  (3 hops, fresh destination per open), `addDevice` refused under `'i2p'`.
- hypergraph `test/next/net/`: an in-memory SAM stand-in (no router) for `'i2p'` and `'dual'` engines: join,
  replicate, helpers and holders, the DHT over datagrams (033's `test.js` approach), a dual peer bridging both halves.
  A slow suite against a real router, run on demand and in the soak.
- Forum scenario: an anonymous member joins a board through a helper, posts, a regular member reads it; a board with
  no helper found through the I2P DHT.
- SwarmFS: EXIF stripped for anonymous uploads (and kept for regular ones), no cross-identity serving.
- HyperBrowser: creating an anonymous identity, "Connecting to I2P…", contacts through the engine, the updater
  paused while an anonymous identity is open and resumed after, the router process surviving a switch, empty device
  name, `--no-guards` refused, the switch warning (both ways, inside and past 10 minutes), forced "don't relay",
  reseed merge from 3 peers.

## Out of scope

- Phones (no app yet); a router on Bare beyond FR-041's check.
- Multi-device anonymous identities (pairing over I2P).
- Pages reaching I2P sites (eepsites) or the normal web through I2P.
- Proxying between the halves (decision 4).
- Paid code signing.
- Defence against a global observer or a targeted state (decision 6).
- Turning a regular identity anonymous, or back.

