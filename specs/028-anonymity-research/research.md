# Research 028: hiding who talks to whom

Written 2026-11-19. Questions and scope: [spec.md](spec.md). Prototype: [research/anonymity/](../../research/anonymity/).

The code numbers come from the copies in `node_modules`: hyperdht 6.36.0, dht-rpc 6.28.0, hyperswarm 4.17.2,
blind-relay 1.6.1, blind-peer 3.16.0, blind-peering 2.10.1. "Accessed" means read on 2026-11-19, when the page had no
date of its own. "UNVERIFIED" marks claims with no primary source.

## The short answer

| Goal | Recommendation | Rough cost | Order |
|---|---|---|---|
| G1 Hide my IP from other peers | Not reachable with Hyperswarm as it is. Make it part of G2's Tor mode, not a separate feature. Use the blind relay (helper VPS) only for what it is good at: NAT. | Relay for NAT: ~1 day. A "relay only" mode in hyperdht: an upstream change, weeks, and it still leaks to the DHT | 3 |
| G2 Anonymity from a network observer | An opt-in **Tor mode** per space: onion services, talking to a local C tor (now) or Arti (later) over SOCKS5. No DHT in that mode: onion addresses carried in invites and member records. I2P is a good second option; Veilid is not ready. | Prototype done (~250 lines). A product version: ~3–5 weeks (transport seam in `lib/network.js`, onion addresses in invites and records, tor bundling for desktop, helpers reachable as onion services) | 2 |
| G3 Reaching a blocked network | Run **our own DHT bootstrap nodes** next to Holepunch's (removes one dependency for everyone). For censored users, rely on Tor's pluggable transports (Snowflake, WebTunnel) through Tor mode: don't build our own. | Bootstrap nodes: ~1–2 days + a VPS. PTs: free once Tor mode exists (configuration) | 1 |

| G2+ Correlation-resistant mode for high-risk users | Later: Katzenpost (free, live but pre-alpha) for notices and invites only; the bulk goes to a holder over Tor at a random later time. Wait for an audit and a larger network | ~2–3 weeks once Tor mode exists | 4 |

Proposed order: **G3 bootstrap nodes** (cheap, helps everyone) → **G2 Tor mode** for chat and forums → G1
falls out of G2 → a mixnet layer for notices, once Katzenpost matures. Nothing here suggests rebuilding the core: the one root choice that limits us is that everything
assumes the DHT and IP-level hole punching, and hypergraph already funnels all of it through one place (below).

## RQ1 (G1): the blind relay

**How it works.** `relayThrough` is an option of `dht.connect` and `dht.createServer` (`hyperdht/lib/connect.js:53`,
`lib/server.js:34`), and of `new Hyperswarm({ relayThrough })`. Peers first do the normal hyperdht handshake through
DHT nodes; the payload then names a relay key and a random token (`connect.js:455`). Both connect to the relay, which
pairs them by token and forwards UDP stream packets (`blind-relay` README, Apache-2.0). The end-to-end Noise stream
runs through it (`connect.js:829`), so the relay can't read the data. Not in the hyperdht README; Holepunch's docs say
"HyperDHT does not do any relaying by default" (https://docs.pears.com/howto/connect-two-peers-by-key-with-hyperdht/,
accessed). Server side: `blind-relay-service` 2.2.2 (npm, 2026-10-07).

**What the relay learns.** Both peers' IP and port, both peers' hyperdht public keys (in hypergraph, the device key:
`lib/index.js` gives the swarm the device key pair), when they talk and how many bytes. Not the content.

**What it doesn't hide (the important part).**

- **The other peer still learns my IP.** The handshake payload carries `addresses4`, my public address and LAN
  addresses (`connect.js:433-447`, `server.js:387-390`), whether or not a relay is named.
- **Hole punching still runs**, in parallel, and the direct path wins when it can (`connect.js:534` starts the relay
  next to the puncher; `server.js:429` likewise).
- **The DHT sees my IP anyway.** Announces and lookups are plain UDP from my address; the announcer even records my
  address as seen by its DHT nodes (`hyperdht/lib/announcer.js`). DHT node ids are `hash(host, port)`
  (`dht-rpc/lib/peer.js:19-22`).

**Measured** (local DHT, `bench.js relay` and `relay-only.js`, 2026-11-19):

- With `relayThrough` forced on both sides, the relay paired the two peers (`pairings.matched: 1`), then the
  connection ended up **direct** and the relay streams closed.
- With every veto hyperdht offers (`holepunch: false` on the server, `holepunch: () => false` and
  `localConnection: false` on the client, `shareLocalAddress: false`), the connection was **still direct**: a reachable
  server is dialed straight away (`connect.js:227`, `!relayed` branch near `connect.js:540`). On a real network behind
  NAT the vetoes may leave only the relay: UNVERIFIED, but the address in the handshake leaks either way.

**Cost.** For NAT help (its real job): pass `relayThrough` to Hyperswarm and run `blind-relay-service` on the helper
VPS: about a day. For hiding IPs: hyperdht would need a "relay only" mode that sends no addresses and never punches.
That is an upstream change to Holepunch's code, and the DHT would still see the IP. **Verdict: a blind relay is a NAT
tool, not a privacy tool.** G1 is better met by G2.

## RQ2 (G2): Tor, I2P, Veilid

### Tor via Arti (and C tor)

- **Versions.** Arti 2.8.0 (blog 2026-11-03; `arti-client` crate 0.48.0 on 2026-11-04), MIT OR Apache-2.0, by the Tor
  Project (https://blog.torproject.org/arti_2_8_0_released/). C tor 0.4.9.x is the stable series (first stable
  0.4.9.5, 2026-02-12); several high-severity fixes in 2026, two-week releases since 0.4.9.12 (oss-security
  2026-09-08 and 2026-09-24, from summaries). The Windows Tor Expert Bundle 16.0.1 was the newest Windows build on
  dist.torproject.org on 2026-11-19.
- **Onion services in Arti.** "Ready for use, but not all features of C Tor are available"
  (https://arti.torproject.org/, accessed). Restricted discovery and vanguards implemented; proof-of-work against DoS
  is experimental on the service side (https://onionservices.torproject.org/dev/implementations/, 2026-08-19). No
  official "production ready" claim, and 2.7 and 2.8 carried security fixes for onion service operators: **usable but
  young**.
- **Embedding.** Rust crate (`arti-client`); an RPC with a C library (`arti-rpc-client-core`); no control port, so no
  `ADD_ONION`. Whether the RPC can create onion services at runtime: UNVERIFIED. C tor has the control port
  (`ADD_ONION`, https://spec.torproject.org/control-spec/commands.html). From JS: SOCKS5 (the `socks` npm package, or
  ~50 lines as in `research/anonymity/tor.js`); the control-port npm packages are unmaintained since 2019–2022, so a
  small client of our own. `tor-js` (Arti in WASM) does HTTPS requests only.
- **Platforms.** Windows, Linux, macOS (C tor and Arti). Android: Tor's own **Tor VPN beta is built on Arti**
  (https://blog.torproject.org/tor-vpn-beta/, 2026-09-09); Orbot exists. iOS: Arti has an iOS build guide
  (https://arti.torproject.org/integrating-arti/); no Arti-based iOS app found (UNVERIFIED).
- **Speed** (Tor Metrics OnionPerf medians, 2026-10-20 to 11-18, https://metrics.torproject.org/): round trip ~520 ms
  to an onion service (~330 ms to a normal server); ~2.8 Mbit/s onion throughput; 5 MiB in ~19 s. Measured here
  with hypergraph over C tor (RQ6): a post arrives in 0.6–1.9 s (median per run), joining takes 2.6–17 s, bulk runs
  at 0.1–0.4 MB/s. Fine for chat and forums, poor for media.
- **Phones as relays.** Tor relays need ≥10 Mbit/s, ≥100 GB/month, a stable IP for 3+ hours
  (https://community.torproject.org/relay/relays-requirements/): phones are clients only, matching P4. A phone hosting
  an onion service is fine while the app is open; Android background limits apply as for any app.
- **Known attacks.** End-to-end traffic correlation (by design, Tor doesn't stop an observer of both ends: Tor design
  paper 2004; "Users Get Routed", CCS 2013); guard discovery against onion services (vanguards help); Sybil relays
  (KAX17, hundreds of relays, removed 2021, kept coming back: https://blog.torproject.org/malicious-relays-health-tor-network,
  2022-04-25); onion service DoS (proof-of-work defence,
  https://blog.torproject.org/introducing-proof-of-work-defense-for-onion-services, 2023-08-23).
- **No UDP.** Tor carries TCP only; UDP proposal 348 is open and doesn't cover onion services
  (https://spec.torproject.org/proposals/348-udp-app-support.html). So hyperdht can't run over Tor: a Tor mode must
  drop the DHT, as P2 says.

### I2P via i2pd

- **Version.** i2pd 3.0.0 (2026-10-20, "Full SAM 3.3"), BSD-3, by PurpleI2P
  (https://github.com/PurpleI2P/i2pd/releases). Java I2P 2.14.0 the same day; same network.
- **Embedding.** A small C++ API (`libi2pd/api.h`: start, create destination, create/accept stream) but no Node or
  Bare binding. The easy route is the daemon plus **SAM v3** on TCP 7656 (on by default in i2pd):
  `SESSION CREATE STYLE=STREAM`, then on a new socket `STREAM CONNECT` (or `STREAM ACCEPT`), after which the socket is
  a raw byte pipe: exactly what hypercore needs (https://i2p.net/en/docs/api/samv3, accessed). Writing our own SAM
  client is ~60 lines; the npm one (`@diva.exchange/i2p-sam` 5.5.2, Apache-2.0) has one maintainer and no commits
  since 2025-10.
- **Platforms.** Windows, Linux, macOS, Android (i2pd app, also on F-Droid). iOS is listed in the README but no
  maintained app exists (UNVERIFIED that it builds today).
- **Relaying.** Every router relays by default, but `notransit=true` turns it off and floodfill is off by default
  (https://docs.i2pd.website/en/latest/user-guide/configuration/). So a phone can be a client only (P4). No battery
  figures published (UNVERIFIED).
- **Speed.** Round trip usually 1–3 s, 20–50 KB/s per tunnel, and the SAM spec warns a tunnel build "can take a minute
  or more" (i2p.net performance page and SAM spec; the figures came via search summaries: partly UNVERIFIED). Slower
  than Tor; fine for records.
- **Bootstrap.** Reseeding: signed `su3` bundles from several independent operators, or a file passed by hand
  (https://i2p.net/en/docs/misc/reseed/). Studies saw reseed servers blocked by DNS poisoning in China
  (https://www.i2p.net/docs/research/hoang2019.pdf).
- **Known attacks.** The netDb doc admits no full answer to floodfill Sybil: "only a few routers are sufficient to
  'eclipse' a portion of the keyspace" (https://i2p.net/en/docs/overview/network-database/). Real incidents: malicious
  floodfill DoS (https://i2p.net/en/blog/2023/02/09/about-the-recent-denial-of-service-attacks/), a client-linking
  attack fixed with per-client netDb views (https://i2p.net/en/blog/2024/03/29/many-masks-one-mind-securing-the-netdb/),
  and the Kimwolf botnet halving capacity in February 2026 (Krebs, 2026-02-11, press). "Practical Attacks Against the
  I2P Network" (RAID 2013).
- **Verdict.** Technically the best fit after Tor (a raw stream per connection, every OS but iOS, relaying optional),
  but slower, a smaller network (15–20k routers a day, press figure), and weaker on mobile. A good second backend
  behind the same seam, not the first.

### Veilid

- **Version.** 0.5.8 (2026-11-02), MPL-2.0, Veilid Foundation (from cDc, DEF CON 2023)
  (https://gitlab.com/veilid/veilid/-/releases). Still 0.x, breaking API changes in 0.5.8, and **no audit**: "Audits
  are on our roadmap but we do not have any to share yet" (https://veilid.com/documentation/audits/).
- **Model.** The sender's safety route plus the receiver's private route, 3 hops by default; its own docs list known
  weaknesses (shared packet traits at each hop, a hop count that leaks position)
  (https://veilid.com/documentation/private-routing/).
- **Bindings.** Rust core, Flutter (mobile and desktop), Python (needs a separate headless node), WASM (browser only).
  **No Node or Bare binding.** VeilidChat is in beta on iOS and Android (https://veilid.com/chat/beta/, 2026-09-28).
- **Fit.** A whole stack (its own DHT, storage, routing) with 64 KB messages, not streams: hypercore would need a
  stream layer on top. **Not ready for us**: no audit, unstable API, no binding. Worth watching for its mobile-first
  design.

## RQ3 (G3): reaching a blocked network

- **Tor's pluggable transports** do this job and keep doing it: WebTunnel is the main answer where obfs4 is blocked
  (China, Russia); Snowflake is the most used in Iran; Conjure is rolling out but not yet working in China
  (https://blog.torproject.org/staying-ahead-of-censors-2025/, 2025-12-03; anti-censorship meeting notes 2026-08-06).
  Arti runs external PT binaries (https://arti.torproject.org/censorship/pluggable-transports, 2026-07-23); lyrebird
  bundles obfs4, Snowflake and WebTunnel. Using WebTunnel with Arti: UNVERIFIED in docs.
- **Our own DHT bootstrap nodes.** Today every new peer contacts `node1–3.hyperdht.org` (Holepunch,
  `hyperdht/lib/constants.js:17-20`). Blocking three IPs blocks first contact. Our own nodes (the helper VPS can be
  one) remove the single dependency, but a censor can block ours just as easily: this is resilience, not
  circumvention. The UDP DHT itself is easy to fingerprint and block.
- **Bootstrapping through Tor**: not possible for hyperdht (UDP). In Tor mode there is no DHT to bootstrap: the invite
  carries the onion address.

## RQ4: an anonymous mode

**One seam already exists.** Every network exit in `lib/` goes through `hg._network.swarm`: connections
(`lib/network.js`), pairing (`lib/pairing.js`), holders (`lib/holding.js` runs its holder server on that swarm), and
the DHT for blind peering (`lib/helpers.js:42`, `lib/holding.js:489` use `swarm.dht`). The prototype replaces that
one object (`research/anonymity/stream-swarm.js`, ~80 lines) and hypergraph replicates a space unchanged. With no
DHT, helpers and holder hand-offs simply stay off; they would need to reach helpers by onion address too.

**Finding peers without the DHT.**

- **Invites** carry the inviter's onion address (or several: members known to be online).
- **Member records** carry each member's onion address, so anyone in the space can dial anyone; a new address
  replaces the old one.
- **Helpers** (the VPS) run an onion service too: always reachable, and they relay records for members who are rarely
  online. The helper then sees which onion addresses (not IPs) sync which space.

**Pseudonymity vs anonymity.** Tor hides the IP, but one identity key used everywhere links every session and every
space together: that's pseudonymity. For anonymity a person needs a **separate identity per context** (Briar,
Cwtch and Quiet do this). Hypergraph has one identity per person and one device key per device, and the device key is
the swarm key: in Tor mode the device key and the onion key must be fresh per anonymous identity. The forum would
see "a member", not "Tibo's laptop". This is an app choice (an anonymous profile = a separate `Hypergraph.open`
folder) and needs no core change.

**What must never touch Hyperswarm in that mode.** No `Hyperswarm`, no `HyperDHT`, no blind peering over the DHT,
no `relayThrough`, no LAN discovery, no DNS lookup of an onion name outside tor. The safe build: an anonymous profile
whose network object has no DHT at all (as in the prototype), so a forgotten call fails instead of leaking. A space
that mixes modes is possible (a member online on both bridges the two), but that member sees the anonymous member's
key and traffic timing.

### The closest precedent: Quiet

Quiet (Tor + libp2p + a CRDT log, 11.3.1 on 2026-10-28, https://github.com/TryQuiet/quiet) is nearly the design
above, built and shipped: one isolated network per community, peers reach each other **only by onion address**,
invites replace a public DHT, the owner signs member certificates, a Node.js backend on phones (nodejs-mobile),
30–100 members per community, not audited. Its threat model (https://github.com/TryQuiet/monorepo/wiki/Threat-Model)
admits what ours would: any member can spam, a removed member can still see who is online, timing leaks to a global
observer, and iOS needs a push server. Proof that the shape works, and that it suits small groups.

## RQ5: lessons on Sybil, eclipse, spam

| System | What it does | Lesson for us |
|---|---|---|
| GNUnet R5N | A random walk before normal DHT routing; every hop checks data by type; assumes Sybils exist, so no voting or punishing peers (draft-schanzen-r5n-07, https://lsd.gnunet.org/lsd0004/, 2026-02-07) | Trust data you can check (signatures), never peers. Hypercore already does this: a fake peer can't forge a block. |
| Hyphanet | "Friends" mode (darknet) for the high security levels; an encrypted store you can't choose, for deniability (https://www.hyphanet.org/pages/documentation.html). The **Pitch Black** attack broke darknet routing with a few nodes (Evans, GauthierDickey, Grothoff, ACSAC 2007) | Friend and invite graphs are good for **trust** (who may write), bad for **routing**. Our spaces already gate writing by invite and role. |
| Tor | A small set of directory authorities sign one consensus; new relays get almost no traffic for days, the Guard flag after 8 days (https://blog.torproject.org/lifecycle-of-a-new-relay/); a few long-lived guards per client (https://spec.torproject.org/guard-spec/). Still needed people to catch KAX17 | Time-to-trust and keeping known-good peers work; pure P2P has no curator, so pin peers you know (members, helpers). |
| I2P | Open floodfills: eclipsed and DoS'd in practice (2023, 2026) | The DHT is the soft spot of every open network. |
| S/Kademlia, IPFS | Ids that cost work and lookups over disjoint paths (Baumgart & Mies, ICPADS 2007); IPFS eclipsed (Prünster et al., USENIX Security 2022) and a 2025 preprint says it still can be (https://arxiv.org/abs/2505.01139) | Disjoint lookups and known-peer caches are the cheap defences. |

Mapped to our weak spots:

- **Free identities in public spaces (spam).** Identity cost doesn't stop a botnet (Kimwolf had ~700k bots). What
  works is what we have and should lean on: write gates per space (invites, roles), per-writer rate limits
  (`setWriteLimit`), moderation, and time-to-trust (a new member's posts limited until vouched for). Public spaces
  stay spammable by design, as in Quiet.
- **DHT eclipse.** A space's members are reached through its topic, which a Sybil can surround. The DHT node id is
  `hash(host, port)` (`dht-rpc/lib/peer.js:19`): it stops choosing ids freely, but one IP can make many ids through
  its ports, so it is weaker than BitTorrent's BEP42 (https://www.bittorrent.org/beps/bep_0042.html) (an inference, not
  tested). Cheap defences that fit hypergraph: dial known members and helpers directly by key (`joinPeer`) instead
  of only through the topic; keep last-seen peers; let invites carry peer keys. hypercore's signatures mean an
  eclipse can hide data, never fake it.
- **Holder metadata.** Holders and helpers see which keys they store, sizes and timing. Tor or I2P hide only the IP.
  Hyphanet hides holdings by storing encrypted chunks the node can't choose: out of scope. Accept it and say so in the
  docs; private spaces already encrypt content.
- **Holepunch bootstrap dependence.** I2P's answer: several independent operators, signed lists, a file by hand.
  Ours: run our own bootstrap nodes beside Holepunch's, cache known DHT nodes, let an app pass its own list
  (`opts.bootstrap` already exists).

**Is a root choice wrong?**

- **hyperdht (a Kademlia DHT)**: not wrong. Every system compared (I2P, Veilid, GNUnet, IPFS) uses one; its weak spot
  is the same everywhere. Use it to find peers, never to trust them; that is how hypergraph uses it. It is wrong only
  for anonymity, where it must be switched off (Tor mode).
- **Autobase (a multi-writer log)**: no evidence against it; Quiet's CRDT log has the same shape and the same risk
  (spam), handled by writer gating and removal, which hypergraph has.
- **One identity per person**: right for the goal (an easy social kit: one person, many spaces, known to their
  friends), but it is the choice that defeats anonymity: one key links everything a person does, IP hidden or not.
  Quiet, Briar and Cwtch scope identity to a profile or community. The fix needs no core change: an anonymous profile
  is a separate hypergraph folder (its own identity and device key), and the app says that a profile is linkable
  across its spaces.

## RQ7 (G2): mixnets, free options only

**Why.** Tor doesn't stop someone who watches both ends and matches timing; Tor says so itself
(https://support.torproject.org/about/attacks-on-onion-routing/). In the German Ricochet case, police found the
Tor guard of an old Ricochet build, then matched netflow timing (Tor Project, https://blog.torproject.org/tor-is-still-safe/,
2024-09-18, updated 2024-10-10; no CCC primary source found). A mixnet mixes, delays and pads packets with cover
traffic, so the timing at the two ends no longer lines up. The price is seconds of delay and small fixed-size
packets. Our traffic is mostly asynchronous, so the delay can be acceptable for notices and chat.

**Excluded.** **Nym**: left out by the brief's rule (no paid credentials). Its paid zk-nyms are for NymVPN. Its own
docs (updated 2026-11-18) say "SDK integrations currently connect to the Mixnet without requiring credentials",
with older wording saying they "soon" will (https://nym.com/docs/network/cryptography/zk-nym/zk-nym-overview). So it
is free today with a paywall planned. Users can still run NymVPN themselves, like any VPN, under a Tor-mode
hypergraph. **HOPR**: senders pay per packet in tokens (https://docs.hoprnet.org/node/guide-using-a-hoprd-node), so
it's out. **Mixmaster, Mixminion**: dead.

| | Katzenpost (Echomix) | xx network (cMix) | Loopix, Vuvuzela, Karaoke, Stadium |
|---|---|---|---|
| Free for users | No fee anywhere in the docs; "free" not stated in words | No user fee seen; nodes are paid by the xx blockchain | Research only, no public network |
| Public network | **namenlos**: 7 mix nodes, 4 gateways, 4 storage nodes, all up on 2026-11-20 (https://status.namenlos.network/). A tiny anonymity set | Claims 350+ nodes in 50+ countries (https://xx.network, undated) | none |
| Platforms | `kpclientd` for Linux and macOS, plus Windows per the README (no GitHub release today: UNVERIFIED); Android (the hushphone client); no iOS | Go SDK builds for Windows, Linux, macOS and WASM; xx messenger on Android 8+ and iOS 14+ | n/a |
| Embed or service | A **local Go daemon**; apps speak its thin-client protocol over TCP or a Unix socket: CBOR behind a 4-byte length (https://katzenpost.network/docs/specs/thinclient/) | An embedded Go library (`xxdk`) or WASM | n/a |
| Latency, throughput | Measured on namenlos: ~25 s to write one message, ~24 s to read one (https://katzenpost.network/blog/2026/11/05/introduction-to-pigeonhole-protocol/); no throughput figures | Not published per message (UNVERIFIED); its docs warn the client drains the battery | Loopix: seconds end to end (https://arxiv.org/abs/1703.00536); Vuvuzela ~37 s for 1M users; Karaoke 6.8 s for 2M users (OSDI 2018) |
| Offline people | **Pigeonhole** boxes kept 1–2 weeks: a mailbox, like our holders | Messages wait in the network (details UNVERIFIED) | Everyone must be online every round: bad for phones |
| Maintainer, audit, licence | The Katzenpost project (NLnet-funded); very active (v0.0.111 on 2026-11-14); **no audit**, "pre-alpha"; AGPL-3.0 | xx foundation, which also chooses the node set; BSD-2 client, a Business Source Licence on servers; audit UNVERIFIED | n/a |
| Node or Bare client | None, but easy to build: TCP + length prefix + CBOR, ~100 lines. Users still run the Go daemon beside it | None; the WASM build might run in Node (UNVERIFIED); Bare would need a Go sidecar | n/a |

**How it would carry our traffic.** Not whole replication streams: 25 s per small message rules out hypercore's
blocks, proofs and handshakes. Small messages fit well: "there's new data for you" notices, invites, swapping onion
addresses, tiny records such as a chat line. The bulk would still go over Tor (or Hyperswarm, which gives no
anonymity).

**Does "mixnet for small, Tor for bulk" keep the protection?** Only partly, said plainly:

- The Tor part is still Tor. If Alice's Tor stream goes straight to Bob, someone timing both ends learns that
  "Alice and Bob talk", and the mixnet adds nothing.
- The two can also give each other away: a notice arrives, and two seconds later Bob opens a Tor connection.
- The protection mostly holds when the bulk goes to a **holder or helper**, not to the other person, at a random
  later time, in short transfers. A watcher then learns only "Alice talks to helper H", which many people do.
  Hypergraph's holders already work that way, which is the one real advantage we have here.

**Prototype: not done.** It would mean downloading or building `kpclientd`, and no Windows release is on GitHub
today. A ~100-line Node thin client could then talk to namenlos.

**Verdict.** Katzenpost is the only free mixnet that is both maintained and fits us: a mailbox design, a small local
protocol, and its network is live. But it is pre-alpha, unaudited, runs 7 mix nodes, takes ~25 s a message, and has
no iOS client. The xx network is larger, but one foundation chooses its nodes and it has no Node client. **Not now**:
a mixnet option for high-risk users belongs **after** Tor mode, as a notices-only layer: notices and invites go over
Katzenpost, and the bulk goes to a holder over Tor at a random later time. Rough cost: ~2–3 weeks (a thin client in
JS, a notices channel in the transport seam, bundling an AGPL daemon as a separate process, random delays for holder
fetches). Look again when namenlos grows and gets an audit.

## RQ6: prototype results

Two engines on this PC (Windows 10, Node 26.4.0), one public space: B redeems the public link and waits for the
first post (join), then gets 20 posts one by one (latency: a post on A until B has it), then 40 posts of 16 KB
(bulk, including A's own write time).

| Transport | Runs | Join (redeem → first post held) | Post latency, median / p95 | Bulk 16 KB posts |
|---|---|---|---|---|
| Hyperswarm, local DHT (2026-11-20) | 3 | 56–106 ms | 2–3 ms / 4–10 ms | 5.8–7.1 MB/s |
| Hyperswarm + blind relay (2026-11-19) | 1 (10 posts, 20 bulk) | 209 ms | 5 ms / 8 ms (max) | 4.1 MB/s (path ended up direct) |
| Stream adapter, plain TCP, no DHT (2026-11-19) | 1 (10 posts, 20 bulk) | 113 ms | 3 ms / 5 ms (max) | 5.7 MB/s |
| **Stream adapter over Tor**, two tor clients, an onion service (2026-11-20) | 3 | **2.6 s, 5.2 s, 17.4 s** | **0.6 / 0.7 s, 1.0 / 1.4 s, 1.9 / 2.2 s** | **88, 108, 423 KB/s** |

Tor runs in detail: **C tor 0.4.9.16** from the Tor Expert Bundle 16.0.1 for Windows (dist.torproject.org; SHA-256
checked against `sha256sums-signed-build.txt`, GPG signature not checked), **not Arti**. Each run starts two fresh
tor clients (`ClientOnly 1`, one hosting the onion service): bootstrap 7–18 s; then the onion address answered
5–10 s later. So a cold start took 19–26 s before the scenario's clock began; a client whose tor already runs and
a service already published skip that.

- **They match Tor Metrics** (~520 ms round trip, ~2.8 Mbit/s): a post needs about one to two round trips
  (B learns there is a new block, asks for it, gets it), so 0.6–1.9 s. Bulk at 0.1–0.4 MB/s is below Tor Metrics'
  ~0.35 MB/s at its best because each 16 KB post waits for its own round trips. The spread between runs is the
  circuits each run happened to get.
- **They change no recommendation.** Tor mode is fine for chat and forums (a post shows up in about 1–2 s; joining
  takes seconds) and poor for media (a 10 MB file would take ~25 s to ~2 min). P3 holds.
- The adapter is as fast as Hyperswarm on one machine: the cost of an anonymous mode is the network under it, not
  hypergraph.
- The local numbers (Hyperswarm, relay, TCP) are a lower bound: no real network between the engines. The Tor
  numbers are real: both clients went through the live Tor network, even though both ran on this PC.

## Could not verify

- Tor through Arti (only C tor was measured); Tor between two machines or on a phone (both clients ran on this PC).
- Whether hyperdht's holepunch vetoes leave only the relay behind a real NAT (tested only on a local DHT).
- Whether Arti's RPC can create onion services at runtime; Arti's default SOCKS port; an official "production ready"
  for Arti onion services; Orbot on Arti or C tor; an Arti-based iOS app.
- Onion service connection setup time (not in Tor Metrics).
- obfs4 and meek status in 2026 from a primary source; WebTunnel with Arti.
- Whether the `socks` npm package runs on Bare (a hand-written SOCKS5 over `bare-tcp` would).
- KAX17 scale figures (press, 2021); the exact wording of C tor 0.4.9.12/13 announcements.
- I2P speed figures (from search summaries of i2p.net pages); i2pd on iOS today; I2P and Veilid battery cost on
  phones; the 2026 I2P botnet numbers (press, not the I2P project).
- Whether a Veilid node can refuse to relay; that no Node or Bare binding exists (none found).
- Whether Quiet still uses OrbitDB in 11.x.
- Mixnets: a downloadable Windows `kpclientd`; Pigeonhole box size and throughput; an explicit "free" for namenlos;
  xx's per-message latency, payload size, audit and node count today; whether `xxdk` WASM runs in Node; when Nym's SDK
  starts requiring credentials; a CCC primary source for the Ricochet case.
- That `hash(host, port)` lets one IP make many DHT ids (an inference from the code, not tested); no published
  security analysis of hyperdht was found.
