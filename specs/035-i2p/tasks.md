# Tasks 035: I2P

Plan: [plan.md](plan.md). HB = HyperBrowser, HG = hypergraph, SFS = SwarmFS. Each phase: `--quick` while working,
`--merge` before the report; docs and tests in the same commit.

## Phase 1: router foundations

- [x] T001 HB: move the addon sources to `router/addon/`; options object, `status()`, delay-load host binding
- [x] T002 HB: build on Windows (spike's deps), Defender scan, `router/addon/check.js` smoke run
- [x] T003 HB: load the addon in Bare; report result (fallback: Electron `utilityProcess`)
- [x] T004 HB: 20 `stop()`/`start()` cycles in one process: RSS, handles, crash check
- [x] T005 HB: `router/process.js` (Bare) + `shell/router.js` supervisor: free SAM port, backoff restarts; tests
- [x] T006 HB: 20 SAM session open/close cycles against one router process, transit/tunnels kept
- [x] T007 HB: start the soak run in the background (`router/soak.js`, JSONL in temp)
- [ ] T008 HB: CI workflow: addon for Windows/Linux/macOS, Defender scan, fail on detection; release steps in docs (written; not run until pushed)
- [x] T009 HB: perf scenario FR-040 (start to tunnels, RSS, idle CPU); docs

## Phase 2: discovery inside I2P (HG)

- [x] T010 `lib/i2p/sam.js` with tests against an in-memory SAM stand-in (`test/next/net/_sam.js`)
- [x] T011 dht-rpc address codec (32-byte destination hash): vendored under `lib/i2p/dht-rpc/` (peer.js, index.js changed; io.js, query.js changed only for the address size)
- [x] T012 `lib/i2p/dht.js`: announce/lookup, signed records, expiry, client-only mode; net tests
- [x] T013 real-router test and perf FR-037, on demand (`HG_I2P_SAM`); docs

## Phase 3: transport seam (HG)

- [x] T014 `transport`/`sam` options on `Hypergraph.open` → `Network`; option checks
- [x] T015 lazy requires (network, holding, pairing); `require.cache` test; `addDevice` `NOT_ALLOWED`; no circle holder over I2P only
- [x] T016 `lib/i2p/swarm.js`: session (3 hops, fresh destination), ready wait, `transport` events, retry
- [x] T017 join/listen/`dht.connect` over SAM streams + secret-stream; helpers and holders on I2P
- [x] T018 `'dual'`: both paths, Hyperswarm wins; bridge test `'i2p'` ↔ dual ↔ `'normal'`
- [x] T019 `JOIN_TIMEOUT` from first connection (invites don't carry helpers' I2P addresses: a helper's key is found through the I2P DHT; `sam.bootstrap` starts it)
- [x] T020 loopback-only socket hook test (SC-001); forum scenarios (helper join, no-helper DHT find)
- [x] T021 perf FR-038, FR-039; docs (api, concepts), CHANGELOG; SwarmFS suite

- [ ] T021b HB: UPnP in the addon (miniupnpc, `upnp` option, on by default); Defender; reachability and transit

## Phase 4: SwarmFS

- [x] T022 `transport`/`sam` through `SwarmFS.open`
- [x] T023 metadata strip (JPEG, PNG, WebP) for `'i2p'` uploads before hashing (a stripped copy in the instance folder; photos stay out of linked folders); tests both ways
- [x] T024 no cross-identity serving test; docs

## Phase 5: HyperBrowser

- [ ] T025 supervisor → engines (SAM port); "Connecting to I2P…" with reason
- [ ] T025a SAM bootstrap list shipped with the app; dual-stack peers hand fresh I2P DHT nodes to regular identities (as reseeding); anonymous identities use only the shipped list and what they learn over I2P
- [ ] T025c user docs: anonymous identities pair no device and hold no circle member's spaces (why)
- [ ] T025b one warm spare SAM session (fresh destination, tunnels built, no identity) handed to the next anonymous identity; SC-008 measured; if still over 15 s, SC-008 changed to the measured number
- [ ] T026 "Anonymous" at creation, list entry, marks in list and frame
- [ ] T027 contacts via the engine network; updater pause/resume; empty device name; `--no-guards` refused
- [ ] T028 switch warning (both ways, 10 min, shell memory)
- [ ] T029 relaying settings page; strict-country "don't relay" from OS time zone and locale (documented as weaker)
- [ ] T030 reseed through ≥3 peers into the router's netDb
- [ ] T031 large-file notice; 032 notice text if 032 landed
- [ ] T032 leak matrix (14 paths) in docs; user docs in `sites/home/` (threat model, speed, relaying)
- [ ] T033 typecheck, test, test:bare, test:sandbox, selftest

## Phase 6: measurements

- [ ] T034 SC-002, SC-003, SC-005, SC-008 on the real network, median of 5, in perf history
- [ ] T035 soak read (SC-006), FR-023 numbers revisited
- [ ] T036 IP-to-country list (CC-licensed, e.g. db-ip lite) against the router's external IP; download listed for approval first
