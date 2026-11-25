# Plan 035: I2P

Spec: [spec.md](spec.md). Research: [033](../033-i2p-research/research.md) (Q1b for the library build). Three repos,
one branch each (`claude/035-i2p`). Each phase ends working, tested, documented, and is reviewed before the next.

## Where things go

| Part | Repo, place | Runs on |
|---|---|---|
| i2pd addon (source, CMake, build scripts, CI) | HyperBrowser `router/addon/` (moved from hypergraph `research/i2p/lib/`) | built per OS |
| Router process (loads the addon, SAM port, relaying options) | HyperBrowser `router/process.js` | Bare, started like the engine (`PearRuntime.run`) |
| Router supervisor (start with the app, restart with backoff, port to engines) | HyperBrowser `shell/router.js` | shell (Electron main) |
| SAM client (streams, repliable datagrams, naming lookup) | hypergraph `lib/i2p/sam.js` (from `research/i2p/sam.js`) | engine |
| DHT inside I2P (dht-rpc over SAM datagrams, announce/lookup) | hypergraph `lib/i2p/dht.js` | engine |
| Swarm stand-in (join, listen, `dht.connect`, secret-stream over SAM) | hypergraph `lib/i2p/swarm.js` | engine |
| Transport seam | hypergraph `Hypergraph.open({ transport, sam })` → `Network` | engine |
| EXIF/PNG/WebP metadata strip | SwarmFS `lib/strip.js`, no new dependency | engine |
| Anonymous identities, contacts, updater pause, warning, settings | HyperBrowser `shell/`, `engine/` | |

The addon lives with the shell that owns the router. hypergraph never loads it: its real-router tests read a SAM
port from `HG_I2P_SAM`.

## Phase 1: the untested items (FR-041, FR-001–FR-004, FR-023, FR-040)

Stops the plan if it fails (emissary weighed then).

- Addon: options object `start({ dataDir, samPort, bandwidth, share, notransit, ipv6 })`, `stop()`, `status()`
  (router state, tunnels, transit count, for supervision and the soak). Host-independent binding on Windows
  (delay-load hook returning the host exe, as node-gyp does) so one `.node` loads in Bare and Electron's Node.
- Built on Windows here from the spike's sources and vcpkg deps. Scanned with Defender.
- Bare host: the addon loaded by `bare` (Bare's Node-API layer). Fallback if Bare can't: the router process runs on
  Electron's Node (`utilityProcess`); same seam, reported.
- 20 `stop()`/`start()` cycles in one process: RSS and handles before/after. If i2pd's globals don't restart
  cleanly, the router process restarts instead (the supervisor already does that) and the result is reported.
- Router process + supervisor: SAM on 127.0.0.1, free port picked at start; 20 SAM session open/close cycles (the
  identity switch) against one process, transit and tunnels kept (`status()`).
- Linux and macOS: no WSL, so built in CI only: a HyperBrowser workflow building all three OS, Defender scan on
  Windows, failing on detection (FR-003). Written and checked locally where possible (Windows job steps); it runs
  once the lead pushes. The release step and Microsoft submission are documented manual steps.
- Perf: FR-040 router cost scenario (start to tunnels ready, RSS, idle CPU) in HyperBrowser `perf/`.
- **Soak starts here**, in the background, against the router process + supervisor: a script opening and closing a
  SAM session every 10 min, logging RSS, tunnels, transit, restarts to a JSONL in the temp folder; relaying on with
  the FR-023 cap. Read at the end of phase 6 (SC-006, FR-023's numbers).

## Phase 2: discovery inside I2P (FR-013–FR-017, FR-037), hypergraph

- `lib/i2p/sam.js` (hardened 033 client: timeouts, errors as `HypergraphError`, `NAMING LOOKUP`).
- dht-rpc with a pluggable address codec (32-byte destination hash), `adaptiveTimeout: { min: 3000, max: 20000 }`.
  Two commands: announce, lookup (topic → destinations), records signed by the destination, hyperdht's expiry.
  Anonymous engines are clients only (`ephemeral`, no records stored).
- Tests: an in-memory SAM stand-in (`test/next/helpers.js`), 033's `test.js` approach; a slow real-router test on
  demand (`HG_I2P_SAM`).
- Perf: FR-037 lookup time (real router, on demand).

## Phase 3: the transport seam (FR-006–FR-012, FR-020), hypergraph

- `Hypergraph.open(dir, { transport: 'normal' | 'dual' | 'i2p', sam })`; `Network` takes the swarm stand-in.
- Lazy `require` of `hyperswarm`, `hyperdht`, `udx-native`, `blind-pairing` (network, helpers, holding, pairing);
  `addDevice` throws `NOT_ALLOWED` under `'i2p'`.
- `lib/i2p/swarm.js`: one SAM session per open (3 hops, fresh destination, key never saved), `open()` waits for
  tunnels (`transport` events), retries SAM forever. Join = DHT announce/lookup + SAM stream + secret-stream with
  the device key pair. `dht.connect(key)` for helpers/holders via the DHT. Helpers listen on I2P and run DHT nodes.
- `'dual'`: Hyperswarm plus the I2P listener and announce; Hyperswarm wins when both reach one peer.
- `JOIN_TIMEOUT` counted from the first connection.
- Invites carry the helpers' I2P destinations (DHT bootstrap, FR-016).
- Tests: unit (options, lazy requires via `require.cache`, session options, codec); net with the SAM stand-in
  (join, replicate, helpers, holders, a dual peer bridging an `'i2p'` and a `'normal'` peer); a socket hook asserting
  no non-loopback socket (SC-001). Forum scenarios: anonymous member joins through a helper and posts, a regular
  member reads; a board with no helper found through the I2P DHT.
- Perf: FR-038 join time, FR-039 throughput (real router, on demand).
- Docs: `docs/next/api.md`, `concepts.md`, CHANGELOG (breaking: none expected; `transport` is additive).
- SwarmFS suite run after.

## Phase 4: SwarmFS (FR-006, FR-021, FR-022)

- `SwarmFS.open(dir, { transport, sam })` passed through.
- Metadata strip for images uploaded under `'i2p'` before hashing (JPEG APP1/APP13, PNG `eXIf`/text chunks, WebP
  `EXIF`/`XMP`), hand-written; regular uploads untouched.
- Test: no cross-identity serving (two engines, same content, separate storage).
- Docs.

## Phase 5: HyperBrowser (FR-018–FR-019, FR-024–FR-036)

- Router supervisor wired to engines (SAM port passed); "Connecting to I2P…" with reason.
- "Anonymous" at identity creation, saved in the list entry; marked in list and frame.
- Contacts through the engine's network (FR-026); updater paused/resumed (FR-027); empty `deviceName`;
  `--no-guards` refused; the 10-minute switch warning (FR-029).
- Relaying setting page; forced "don't relay" in strict countries by OS time zone and locale (FR-024).
- Reseed through peers (FR-025): regular engines publish netDb router records in a hypercore; before a fresh start
  the router process merges records from ≥3 unrelated peers into its netDb and keeps i2pd's own reseed on.
- Large-file notice (FR-036); 032's notice text if 032 has landed (FR-030–FR-032 otherwise move to 032).
- Leak matrix (FR-028): each of the 14 Q7 paths → a test or a written reason, in HyperBrowser docs.
- User docs in `sites/home/`: threat model, speed, relaying.
- Checks: typecheck, test, test:bare, test:sandbox, selftest.

## Phase 6: measurements and soak result

- SC-002, SC-003, SC-005, SC-008 measured against the real network (median of 5), recorded in `perf/history`.
- Soak read: memory flat, restarts, relayed traffic; FR-023 numbers revisited.

## Decisions taken at review

1. **Strict countries (FR-024)**: i2pd 3.0.0 has no geo-IP. For now the OS time zone and locale decide: either one
   in a strict country turns relaying off; works before the router is up; documented as weaker. Phase 6 adds an
   IP-to-country list (CC-licensed, e.g. db-ip lite) checked against the router's external IP; its download goes to
   the owner for approval then.
2. **dht-rpc codec (FR-014)**: dht-rpc vendored under `lib/i2p/dht-rpc/` until upstream merges. Four files, not
   two: `peer.js` and `index.js` change (index.js also loaded udx-native at the top), `io.js` and `query.js` hard-code
   the 6-byte address size; the other files come from the installed dht-rpc. The owner sends the PR below.
   i2pd sends datagrams to a `.b32.i2p` name itself, so FR-014's `NAMING LOOKUP` isn't needed.
3. **Linux/macOS** build only in CI after the owner pushes; phase 1 reports them as not run.
4. **After phase 1**: SC-008 (switch median 21 s) gets one warm spare session in phase 5, handed to the next
   anonymous identity; if still over 15 s, SC-008 becomes the measured number. Records saved once a minute and
   options read once per process are accepted limits (documented, i2pd not patched). Relaying behind NAT: the
   owner decides; phase 2 checks whether i2pd leaves "Firewalled" over IPv6 on this machine. Merges wait for
   phase 5.

## Upstream PR text (dht-rpc, for the owner to send)

> **Pluggable address codec**
>
> dht-rpc encodes peer addresses as IPv4 `host:port` (6 bytes, `lib/peer.js`) and derives node ids from
> `hash(host, port)`. That ties it to UDP over IPv4. This adds an `addressCodec` option (`encode`, `decode`,
> `id(address)`, default: today's IPv4 codec, no behaviour change) so a DHT can run over another datagram
> transport (we run it over I2P, where an address is a 32-byte destination hash), together with the existing
> `udx` option for the socket. It also replaces the 6-byte size assumed in `lib/io.js` and `lib/query.js` (and the
> DOWN_HINT check) with the codec's size, and requires `udx-native` lazily, only when no `udx` is given. Tests: the
> existing suite unchanged, plus one with a 32-byte codec over an in-memory transport.
