# Research 033: I2P as a second network

Written 2026-11-25. Prototype: [research/i2p/](../../research/i2p/). Follows [028](../028-anonymity-research/research.md),
which chose Tor; the owner and the lead then chose I2P instead, because hyperdht needs datagrams and I2P has them.

Written against the decided design: dual stack; every desktop install bundles a router the engine starts, invisible,
relaying at a default share; regular identities use both networks; anonymous identities use I2P only, never fall back,
get a fresh destination each time they open, and share no storage with another identity; data crosses between the
two halves through replication by dual-stack peers. Threat model: peers, site owners, ISPs, local-network observers;
not a global observer or a state targeting one person.

Setup: one Windows 10 machine, Node 26.4, hypergraph from this branch, dht-rpc 6.28.0, hyperdht 6.36.0. Two routers on
the same machine talk through the live I2P network (each builds its own tunnels; nothing short-cuts locally).
Routers: **emissary 0.4.0** (the official prebuilt `emissary-cli.exe`, sha256 checked). **i2pd 3.0.0 was not run**:
Windows Defender flagged the official zip on download and the unzipped exe after it was restored (Q1). "UNVERIFIED" marks claims with no primary source.

## The short answer

| Question | Finding | Number | Recommendation |
|---|---|---|---|
| 1. Router | emissary runs as a hidden child process (one 17.8 MB exe, own folder, SAM on localhost, no install), light, memory-safe, but young, one main developer, its last release has a known self-shutdown bug, and it quit on a host without IPv6. No antivirus alert. i2pd: mature, C++ with memory-safety fixes in 2026, and **Defender flagged both its official zip and its exe as trojans** (past alerts were false positives; this one is unconfirmed) | emissary: 20–25 MB RAM, 0.1 % CPU idle; first start 187 s; later starts 10–164 s (median 53 s). i2pd: not run | **emissary**, built by us from a commit with its fixes, kept only after a scripted multi-day soak run; i2pd as the fallback. The SAM seam keeps the swap cheap |
| 2. DHT over I2P | `dht-rpc` runs **unforked** over SAM repliable datagrams, through a stand-in for `udx-native` (`opts.udx`). hyperdht can't (UDX streams, IPv4 in its records). Raw datagrams didn't work with emissary | 6 nodes on 2 routers: bootstrap 20 s, 5 of 5 lookups found the target, 1.3–13.2 s (median 3.7 s); 115 retries for 354 datagrams | Own small topic → destination records on dht-rpc, with a pluggable address codec upstreamed (small). Start with the fallback (dual-stack helpers as meeting points) |
| 3. Replication | hypergraph replicates unchanged over SAM streams through 028's stream adapter | Over I2P: join 5.0–7.8 s, a post arrives in 1.2–2.3 s (median), bulk 2.1–8.7 posts/s = 0.03–0.14 MB/s, time to first byte 10–12 s (27–38 s in one earlier run), 6 of 15 connects failed. Hyperswarm, same machine: join 54–120 ms, 2–3 ms, 300–450 posts/s = 4.9–7.3 MB/s | Fine for chat and forums, not for media. Connect before joining: a connect can outlast `redeemInvite`'s 30 s |
| 4. Relay | Defaults: i2pd shares 100 % of its bandwidth limit, emissary 90 % of 1 MB/s. "Don't relay": i2pd `notransit=true`, emissary `--disable-transit-tunnels` | A new emissary router at defaults, first 30 min: **1 transit tunnel**, which carried nothing and closed after 2 min; machine upload 3–12 KB/s with the router vs 6 KB/s without; CPU 0.1 % | Cap it (i2pd `bandwidth`, `share`); no-relay mode on metered links and in strict countries; measure a router that has run for days | Cap it (i2pd `bandwidth`, `share`); no-relay mode on metered links and strict countries |
| 5. Reseed via peers | Works: a fresh router started from router records copied from another router, with no reseed server | 100 records = 99 KB; tunnels ready 56 s; no reseed server contacted | Regular identities ship records from several peers (signed per router), merged with the official reseed; costs 100 KB once |
| 6. What needs plain UDP | Replication, helpers, holders, pairing go through the engine's swarm; **contacts and the updater each open their own Hyperswarm** | 14 items: 3 work as is, 8 need work, 3 can't | A transport seam in `Hypergraph.open` (the `swarm` option exists in `Network`, unused); route contacts through the engine; updater off in anonymous mode |
| 7. Leaks | 14 paths; Electron guards and per-identity folders already close the page-side ones and storage | 3 closed today, 1 open by design (the router shows it runs I2P), 10 open | Anonymous engine without any Hyperswarm code; host name never sent; one SAM session per identity; 3-hop tunnels set explicitly |

## Q1: router choice, i2pd vs emissary

### Measured (emissary 0.4.0, Windows)

| | emissary 0.4.0 | i2pd 3.0.0 |
|---|---|---|
| Size on disk | 17.8 MB, one exe; data folder 0.1–0.2 MB after a run (router records, keys) | zip 4.9 MB; `i2pd.exe` 12.6 MB plus config, certificates and web console files |
| First start: process → SAM up → first session's tunnels ready | SAM up 16.9 s (includes reseeding over HTTPS from 2 servers, ~3 s); tunnels ready 170 s later: **187 s** (1 run) | couldn't measure |
| First start, records from a peer (Q5) | 0.9 s + 56 s (1 run) | couldn't measure |
| Later starts (16 samples, single session, some with two routers starting together) | SAM up 0.2 s; tunnels ready **10–164 s, median 53 s** | couldn't measure |
| Memory, idle | 20–25 MB working set | couldn't measure |
| CPU, idle (15 min, relaying on) | **0.1 %** of one core | couldn't measure |
| Hidden child process | Yes: `--base-path <folder>`, `--disable-ui`, config in `router.toml`, SAM on 127.0.0.1, no install, no window | Per docs yes: `--datadir`, `--daemon=false`, flags for every option; the Windows build is a GUI app with a tray icon (UNVERIFIED headless) |
| Linux | not run (no Linux host without WSL) | not run |

Problems met with emissary, each a cost of bundling it:

- **It quit by itself, exit code 0, no error**, a few seconds after start, on this host (no IPv6 route), while sending
  to an IPv6 peer. With `ipv6 = false` in `[ntcp2]` and `[ssu2]`, it stayed up (3 of 3 boots, then 15 min).
- **It also quit after ~11 min** in a run with IPv6 on, matching upstream issue #340 ("self-shutdown after ~9
  minutes", closed 2026-04-25). The fix and a transit-tunnel panic fix (#341) landed **after** 0.4.0 (2026-04-12);
  master is 29 commits ahead and there has been no release in 7 months. An engine must supervise and restart it.
- A section missing from `router.toml` turns its feature off: no `[reseed]` means no reseeding, no `[transit]` means
  no relaying. Its SAM closes the socket on `NAMING LOOKUP NAME=ME` (we derive the destination from the private key).
- Datagrams: delivered only when addressed by full destination, never by `.b32.i2p` name; SAM ports arrive as 0;
  RAW datagrams never arrived ("malformed datagram" in its log).
- **SAM sessions get 2-hop tunnels by default** (its log: `num_inbound_hops: 2`), where I2P's usual default is 3. An
  anonymous identity must ask for `inbound.length=3 outbound.length=3` explicitly.
- The prebuilt exe has no metrics server (built without that feature), so traffic had to be read from Windows I/O
  counters (Q4).

### Maintenance (GitHub API, the 12 months to 2026-11-25)

| | i2pd | emissary |
|---|---|---|
| Releases | 4 (2.59.0 … 3.0.0, last 2026-10-20) | 3 (0.3.0, 0.3.1, 0.4.0, last 2026-04-12) |
| Commits on the default branch | 1530 | 102 |
| Authors | 31 (one author has most commits) | 8; one author made 73 of the 102 |
| Licence | BSD-3-Clause | MIT |
| Project since | 2013 | repo 2023-12, first release 2025-04 |

### Security (weighed as heavily as the numbers, at the owner's request)

| | i2pd | emissary |
|---|---|---|
| Language | C++ (OpenSSL, Boost): memory-corruption bugs possible | Rust: memory-safe by default; bugs end in a panic (a crash), not memory corruption. Its use of `unsafe` was not counted |
| Audit | none found | none found |
| CVEs | one in NVD: CVE-2017-17066, a remote memory read via Garlic tunnel messages, fixed in 2.17 (2017) | none in NVD or OSV |
| Bugs fixed in 2026 (its tracker) | out-of-bounds read in Base64 decoding (Feb), SIGABRT in the ECIES session during normal traffic (Apr), UBSan "unreachable" reached (May), SIGSEGV in DSA signing (Oct); an open report of suspected data races (Jun) | panics: transit-tunnel `assert!(false)` after ~25 min, self-shutdown after ~9 min, a duration overflow (all Apr, fixed after the last release); SSU2 panics (2025) |
| How the release is supplied | Windows zip uploaded by a maintainer's account; the git tag is GPG-signed (GitHub: valid); no published checksums | exe built by GitHub Actions from the tag (uploader: the Actions bot); commit unsigned; no checksums; exe not Authenticode-signed (checked) |
| Antivirus | **Defender detected `Trojan:Win32/Ravartar!rfn` (severe) on the zip at download, then `Trojan:Win32/Kepavll!rfn` (severe) on the unzipped `i2pd.exe`.** The restored zip's sha256 matched the release. The tracker has the same kind of alert for earlier releases (#2151, #2184, #2185, #2246; Bitdefender #2381), all closed as false positives. This file is unconfirmed | **no alert**, on download or in any run |
| Anonymity defaults | 3-hop tunnels (I2P's default; UNVERIFIED for i2pd 3.0.0 here) | **2-hop** SAM tunnels |
| Network weight | the second most used router after Java I2P (UNVERIFIED: no current share found); its behaviour is well known to the network | new and rare: an emissary router stands out (fingerprinting: UNVERIFIED) |

**Recommendation: emissary, built by us from a pinned commit that has the #340 and #341 fixes, and kept only if it
passes a scripted multi-day soak run. i2pd is the fallback.** Why, in one line each:

- **Antivirus decides the bundling question.** Defender flagged i2pd twice: the official zip on download
  (`Trojan:Win32/Ravartar!rfn`, severe) and, after the owner restored it and its sha256 matched the release, the
  unzipped `i2pd.exe` (`Trojan:Win32/Kepavll!rfn`, severe). Past i2pd releases drew the same kind of alert and were
  closed as false positives; this file is unconfirmed. A router that antivirus quarantines breaks HyperBrowser for users
  and makes it look like malware. **emissary raised no Defender alert at all** (the exe and every run).
- **Memory safety.** The router parses everything strangers send. emissary's bugs end in a panic (a crash, which a
  supervisor restarts); i2pd's 2026 fixes include an out-of-bounds read and crashes in its crypto paths, the kind of
  bug that can turn into a remote memory leak (as CVE-2017-17066 did). For an anonymous identity that is the worst case.
- **Light and embeddable**: one exe, 20–25 MB of memory, 0.1 % CPU idle; Rust, MIT, an embeddable core library.
- **Its weaknesses are fixable on our side**: restart it when it quits; IPv6 off until the shutdown is fixed upstream;
  ask for 3-hop tunnels per session; use repliable datagrams and full destinations (Q2). What we can't fix is that it
  is young, mostly one developer's work and has no audit: hence the soak run and the fallback.
- **i2pd stays the fallback** if emissary fails the soak: mature, 13 years on the network, 3-hop defaults. It would
  need our own signed build from its GPG-signed tag, and a Microsoft false-positive submission (UNVERIFIED that this
  clears the detection).

Not measured: i2pd's start times, memory, CPU and speed (Defender's second alert stopped it before it ran). Building
emissary from source needs its crates downloaded (an approval).

## Q2: a DHT over I2P

**Can dht-rpc run over SAM datagrams unforked? Yes, with a shim.** dht-rpc takes `opts.udx` (`dht-rpc/index.js:39`)
and uses only `createSocket`, `bind`, `address`, `trySend`, a `message` event, `close`, and
`watchNetworkInterfaces` (`dht-rpc/lib/io.js`). [`udx-shim.js`](../../research/i2p/udx-shim.js) (~150 lines)
implements those over one SAM datagram session per node:

- dht-rpc speaks IPv4 `host:port` and checks a node's id against `hash(host, port)` (`dht-rpc/lib/io.js:628`). So
  each destination gets a fixed fake address: the first 4 bytes of its hash, plus a port. Every node computes the same
  fake address for the same destination, so ids check out.
- Replies list "closer nodes" as fake addresses that can't be turned back into destinations. So every datagram
  carries a prefix with the **full destination** of each closer node it lists (emissary can't send to a `.b32.i2p`
  name), and the two ports (emissary drops SAM's `FROM_PORT`/`TO_PORT`). Up to 20 closer nodes × ~390 bytes:
  **~8 KB per reply**, under SAM's ~11 KB advice for reliable datagrams.
- dht-rpc's default timeout is 1 s with 3 retries; I2P round trips are about 1 s and the first datagram to a new
  destination is often lost. `adaptiveTimeout: { min: 3000, max: 20000 }` (an existing option) fixes it.
- Repliable datagrams carry a signed sender. Raw ones don't, so the shim writes the sender in the prefix (unsigned,
  spoofable); with emissary they never arrived anyway.

**Measured over live I2P** (emissary, 6 nodes on 2 routers, one bootstrap node given by destination, 1 run):
sessions ready 80 s; bootstrap 20 s; routing tables 2–5 nodes; 5 lookups, all found the target: 2.3, 13.2, 1.3,
13.1, 3.7 s; 6 timeouts and 115 retries for 354 datagrams. Datagram round trip, same setup: 0.9–1.1 s once the first
one got through. Self-check without a router: [`test.js`](../../research/i2p/test.js) (13 nodes, a target found only
through closer-node prefixes).

**What it doesn't give us.** hyperdht can't run over this: its connections are UDX streams after hole punching
(`hyperdht/lib/connect.js:86`) and its records carry IPv4 addresses (`hyperdht/lib/messages.js:41`). So "a DHT
inside I2P" means our own announce/lookup of topic → destination, as two dht-rpc commands, then a SAM stream.

**Smallest change for a product.** Keep the shim, or upstream one change to dht-rpc: a pluggable address codec (the
6-byte `ipv4` encoding in `dht-rpc/lib/peer.js` and the id hash) so an address can be a 32-byte destination hash. That
removes the prefix and the collisions of 4-byte fake hosts (the shim ignores them: fine for tests, not for a network).
Lookups by hash then need the router to find the destination (`NAMING LOOKUP` of the `.b32.i2p` name): i2pd does this;
emissary's SAM didn't.

**The fallback: dual-stack helpers as meeting points, no DHT inside I2P.** Each space's helpers (already in space
settings) also listen on an I2P destination. An I2P-only member dials the helpers' destinations from the invite, as
in 028's Tor mode; members' current destinations live in member records, so anyone can then dial anyone. Helpers
replicate both halves (the decided "data crosses by replication"). No DHT, no Sybil exposure, works on day one;
the cost is that a space with no helper online can't be found by an I2P-only member. **Start with this**; add the
dht-rpc layer when spaces without helpers need it.

## Q3: replication over I2P

Two engines, one public space, 028's scenario ([`research/anonymity/bench.js`](../../research/anonymity/bench.js)):
B redeems the link and waits for the first post (join), then 20 posts one by one (latency), then 40 posts of 16 KB
(bulk, including A's write time). Over I2P, the engines use 028's `stream-swarm.js` (secret-stream over each socket)
with SAM streams.

| Transport | Runs | Time to first byte | Join | Post latency, median / p95 | Bulk 40 × 16 KB |
|---|---|---|---|---|---|
| Hyperswarm, local DHT, same machine | 3 | — | 54–120 ms | 2–3 ms / 4 ms | 300–450 posts/s, 4.9–7.3 MB/s |
| Plain TCP, same adapter | 1 | — | 77 ms | 2 ms / 5 ms | 430 posts/s, 6.9 MB/s |
| **I2P (emissary), two routers** | 2 | 9.8–12.3 s (6 of 15 connects failed; an earlier run took 27–38 s) | **5.0 s, 7.8 s** | **1.2 / 1.4 s, 2.3 / 2.9 s** | **8.7 and 2.1 posts/s, 0.14 and 0.03 MB/s** |
| Tor (028, for comparison) | 3 | — | 2.6–17 s | 0.6–1.9 s | 0.09–0.42 MB/s |

- A stream took 5–17 s and 2–3 tries before the space could be joined; `redeemInvite` gives up after 30 s
  (`lib/index.js:1471`), which a first attempt hit. An I2P transport must connect first, or that timeout must grow.
- Same-LAN sync: not measured (one machine).
- Over emissary, I2P was slower than Tor in 028. Whether i2pd does better is the main open number.
- Fine for chat, forums and records (a post shows up in 1–3 s). Poor for media: a 10 MB file at 0.03–0.14 MB/s takes
  1–6 minutes. Media for anonymous identities should come from dual-stack holders, in the background.

## Q4: relay bandwidth

**Measured (emissary 0.4.0 at its defaults, 1 MB/s with a 90 % share, fresh router, 30 min, no client of ours):**
the router accepted **one** transit tunnel, at minute 27; it carried nothing and closed after 2 minutes of
inactivity (its debug log). The machine's upload with the router running was 3–12 KB/s per 5 minutes; without it,
6 KB/s: relaying was lost in the noise. CPU 1.6 s in 30 minutes (0.1 % of a core), memory 20–22 MB. So in its first
half hour an average user gives close to nothing: I2P routers pick tunnel hops by measured history, and a new router
has none. What a router gives after days online could not be measured here: it is bounded above by the share
(here up to 0.9 MB/s) and depends on uptime and reachability. Windows' per-process I/O counters don't see socket
traffic (10 MB sent showed as ~1 MB), and the prebuilt emissary has no metrics server, so the numbers are adapter totals.

- **What caps it.** i2pd: `bandwidth` (letters L = 32, O = 256, P = 2048 KB/s, X = unlimited, or a number) and
  `share` (percent of that for relaying, default 100), plus `limits.transittunnels` (default 10,000)
  (https://docs.i2pd.website/en/latest/user-guide/configuration/). emissary: `[bandwidth] bandwidth` (default
  1,000,000 B/s) and `share_ratio` (default 0.9), `[transit] max_tunnels` (default 1000) (its
  `docs/router-configuration.md`).
- **"Don't relay" mode.** i2pd `notransit = true`; emissary `--disable-transit-tunnels`. Both then publish the `G`
  cap ("rejecting all tunnels"), so other routers see a client-only router.
- A new router is picked for few tunnels in its first hours: a 30-minute sample under-states a long-running install.

## Q5: reseeding through our own peers

**Yes.** A new router needs a few dozen router records (`routerInfo-*.dat`, each signed by its router). Test: copy
100 of the 138 records an emissary router held into a fresh folder's `netDb/` and start it with `--disable-reseed`
(`bench.js reseed`). It never contacted a reseed server; SAM up 0.9 s, tunnels ready 56 s (faster than the
187 s of a first start through HTTPS reseeding). i2pd takes the same as a zip: `reseed.zipfile`
(https://docs.i2pd.website/en/latest/user-guide/configuration/). Java I2P's format is a signed `i2pseeds.su3`
(https://i2p.net/en/docs/misc/reseed/).

- **How.** A dual-stack peer (a helper, or any regular identity) offers its current router records as a small file
  over the normal network (a hypercore, or a field next to the invite). The new router merges records from several
  peers before its first start.
- **Cost.** ~100 KB once per new install. No server to run.
- **Risk.** A malicious peer can't forge records, but it can hand over only its own routers, so the new router builds
  every tunnel through it (an eclipse). So: take records from several unrelated peers, and for regular identities
  also use the official reseed servers. Who reseeds the router of an anonymous identity: the router is the machine's,
  started by the engine; reseeding over the normal network tells the reseed source that this IP starts I2P (not who),
  which the router's public record tells the I2P network anyway.

## Q6: what relies on plain UDP or Hyperswarm today

"Works as is" means: works if the engine's Hyperswarm is replaced by a stand-in that dials I2P destinations
(028's `stream-swarm.js` over SAM streams). Read-only survey of hypergraph `lib/`, SwarmFS and HyperBrowser.

| What | Where | Uses | Over I2P |
|---|---|---|---|
| Space replication | `lib/network.js:78` (Hyperswarm), `:128` topic join, `:288` `joinPeer` | DHT announce/lookup, UDP hole punching | **Needs work**: a stand-in swarm, and a way to find a topic's peers (Q2: helpers' destinations first). `Network` takes a `swarm` option (`lib/network.js:38`), but `Hypergraph.open` never passes one (`lib/index.js:246`) |
| Helpers | `lib/helpers.js:62,70`: `BlindPeering(swarm.dht)` | `dht.connect(helperKey)` | **Needs work, small**: the stand-in's `.dht.connect(key)` maps a helper key to its destination |
| Holding, holder side | `lib/holding.js:411-423`, `:545` | `swarm.listen()`, topic announce as server | **Needs work**: listening is accepting on our destination; the announce needs Q2's discovery |
| Holding, circle side | `lib/holding.js:612-624`: `BlindPeering(swarm.dht)` | `dht.connect(key)` | **Needs work**, as helpers |
| protomux-wakeup | `lib/network.js:16,51,299` | existing streams | **Works as is** |
| relayThrough, blind-relay | not set anywhere | — | **Works as is** (nothing to do: I2P is the relay) |
| LAN discovery | hyperdht's own: `localConnection` defaults to true and the handshake sends LAN addresses (`hyperdht/lib/connect.js:84,435`) | DHT handshake | **Can't** (and mustn't): gone with the stand-in; not configurable in `lib/` today |
| Device pairing | `lib/pairing.js:36`: `BlindPairing(swarm)`, which calls `dht.lookup`/`dht.announce` | DHT | **Can't** as is: a pairing code would have to carry a destination |
| hyperdns | `hyperDNS/src/resolve.js:31`: names are records in spaces | hypergraph | **Works as is** (inherits the engine's network; no DNS) |
| Contacts | `HyperBrowser/engine/contacts.js:344`: **its own** `new Hyperswarm` | topic announce/lookup | **Needs work**: bypasses the engine. Off when "findable" is off and no request is pending |
| Updater | `HyperBrowser/shell/updater.js:14`: **its own** Hyperswarm in a separate Bare process | topic join on the upgrade drive | **Needs work** (or off): runs only when packaged with an upgrade link; shared by all identities |
| Electron WebRTC | `HyperBrowser/shell/views.js:72` `disable_non_proxied_udp`, `:55` proxy to a dead port, `:56-57` permissions denied | Chromium | **Can't** carry WebRTC; already closed for site views when guards are on |
| Pages loading outside resources | `shell/views.js:10` CSP, `:51` requests outside `hyper://<key>/` cancelled; navigation and `window.open` blocked | Chromium | **Needs work** only if pages should reach I2P sites; closed when guards are on |
| DHT bootstrap | `hyperdht/lib/constants.js:18-20`; a host name is resolved by DNS (`dht-rpc/index.js:896`) | UDP, DNS | **Needs work**: gone with the stand-in; Q5 replaces it for the router |

## Q7: leaks for an anonymous identity

Every path by which an anonymous identity's engine or pages could reach the network outside I2P, or be linked.

| # | Path | Today |
|---|---|---|
| 1 | The engine's Hyperswarm (`lib/network.js:78`): DHT announces and lookups from the real IP | **Open.** An anonymous engine must be built with no Hyperswarm at all, so a forgotten call fails instead of leaking (028) |
| 2 | Helpers and holders through `swarm.dht` (`lib/helpers.js:62`, `lib/holding.js:612`) | **Open** (follows #1) |
| 3 | Pairing through `dht.lookup`/`announce` (`lib/pairing.js:36`) | **Open**: pairing must be off or carry a destination |
| 4 | LAN addresses in the hyperdht handshake (`hyperdht/lib/connect.js:435`) | **Open** (follows #1) |
| 5 | Contacts' own Hyperswarm (`engine/contacts.js:344`) | **Open**: must go through the engine's transport |
| 6 | The updater's own Hyperswarm (`shell/updater.js:14`), shared by all identities | **Open**: reveals the machine's IP to the upgrade drive's peers whatever identity is open; off, or over I2P, while an anonymous identity is open |
| 7 | The host name as the device name: HyperBrowser passes `os.hostname()` (`shell/main.js:1485`) into the identity's records (`lib/index.js:537`) | **Open**: identifying even over I2P; must be empty for anonymous identities |
| 8 | The router: HTTPS to clearnet reseed servers on first start; UPnP and NAT-PMP on the LAN (on by default in emissary and in i2pd's Windows GUI build); its public router record | **Partly open by design**: reveals that this IP runs I2P, not who. Turn UPnP/NAT-PMP off; reseed via peers (Q5) |
| 9 | One router for two identities: a regular and an anonymous identity on the same router can be linked (the 2024 netDb linking attack, fixed in Java I2P by per-client netDb views: https://i2p.net/en/blog/2024/03/29/many-masks-one-mind-securing-the-netdb/) | **Open**: whether i2pd and emissary isolate per session is UNVERIFIED. One SAM session per identity, a new destination per open (decided), and 3-hop tunnels set explicitly (#14) |
| 10 | Pages: requests outside `hyper://<key>/`, WebRTC, DNS prefetch | **Closed** when guards are on (`shell/views.js:10,19,51,72`) |
| 11 | `--no-guards` turns every Chromium guard off (`shell/main.js:31`) | **Open**: must be refused while an anonymous identity is open |
| 12 | Storage shared between identities (SwarmFS addresses files by content) | **Closed**: each identity has its own engine folder and its own Electron partitions (`shell/identities.js`, `shell/views.js:33`); only one engine runs at a time |
| 13 | Telemetry, crash reporter, Electron `net`, NTP | **Closed**: none in the code |
| 14 | emissary's 2-hop SAM tunnels by default | **Open** if emissary is used: ask for 3 hops per session |

## The I2P network: size, attacks, countries

- **Size.** 15,000–20,000 routers on a given day (an I2P co-founder quoted by Krebs, 2026-02-11,
  https://krebsonsecurity.com/2026/02/kimwolf-botnet-swamps-anonymity-network-i2p/; press). A 2018 measurement
  counted 32k peers a day (Hoang et al., IMC 2018, https://www.freehaven.net/anonbib/cache/i2p-imc18.pdf). Small:
  each HyperBrowser install would be a noticeable share of it.
- **Floodfill and Sybil attacks.** Anyone can become a floodfill (I2P's DHT). I2P's own docs: "only a few routers are
  sufficient to 'eclipse' a portion of the keyspace" (https://i2p.net/en/docs/overview/network-database/).
  Incidents: malicious floodfills in a DoS (2023-02, https://i2p.net/en/blog/2023/02/09/about-the-recent-denial-of-service-attacks/);
  the client-linking attack above (2024-03); the Kimwolf botnet trying to join ~700,000 bots and leaving the network
  at about half capacity (2026-02, Krebs, above). A 2025 preprint claims large-scale de-anonymisation of I2P services
  by matching their online times (https://arxiv.org/abs/2512.15510; preprint, not read in full).
- **What I2P doesn't claim.** No full defence against intersection attacks for low-latency traffic, and no added
  delays (https://i2p.net/en/docs/overview/threat-model). This matches our threat model (no global observer); an
  always-online anonymous identity is exposed to the online-time matching above.
- **Countries.** Blocking measured in 2019: China (DNS poisoning of the site and of 3 of 10 reseed servers), Iran (TCP
  resets), Oman, Qatar, Kuwait (Hoang et al., FOCI 2019, https://www.usenix.org/conference/foci19/presentation/hoang).
  Java I2P keeps a list of 42 "strict countries" ("as of 2024": among them China, Iran, Egypt, Saudi Arabia, Turkey,
  the UAE, Vietnam, Belarus, Kazakhstan, Pakistan, Venezuela) where it stops relaying and stops publishing its record
  (https://www.i2p.net/en/docs/overview/restrictive-countries/). The I2P project knows of no country that forbids
  using I2P; the risk is relaying and being seen to run it. i2pd's docs mention no such list (emissary: UNVERIFIED).
  **"Everyone relays" must turn itself off in those countries.**

## Couldn't check

- **Everything measured on i2pd**: Defender flagged the zip, and after the owner restored it (sha256 matched), the
  unzipped exe. We don't work around antivirus.
- Same-LAN sync speed, and anything between two machines (one machine only). Linux (no Linux host without WSL).
- Raw datagrams (emissary never delivered them); lookups by `.b32.i2p` name (emissary's SAM didn't).
- Relay traffic after hours or days of uptime (30 minutes only); the share actually used by transit, since the
  prebuilt emissary has no metrics.
- Whether i2pd and emissary isolate the netDb per SAM session (#9); i2pd's default tunnel length in 3.0.0; whether
  an emissary router can be fingerprinted on the network; whether signing our own i2pd build clears Defender.
- emissary's use of `unsafe`; any audit of either router (none found).
- The size of the I2P network today from a primary source (press and 2018 figures only).
