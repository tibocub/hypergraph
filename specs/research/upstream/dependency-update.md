# Dependency update (2026-10-15)

Branch `deps-and-upstream`, from `011-spaces-core` (7e067ac). Every dependency and dev dependency at its latest
version on npm; then `npm update` so transitive packages are at the latest their parents allow. Before: the
lockfile installed with `npm ci`.

## Versions

Changed (direct):

| package | before | after | notes |
|---|---|---|---|
| autobase | 7.28.1 | 7.28.2 | closing a base now opens a store session (see below) |
| b4a | 1.8.1 | 1.9.0 | |
| bare-events / bare-fs / bare-os / bare-path / bare-process | 2.8.3 / 4.7.1 / 3.9.1 / 3.0.0 / 4.4.1 | 2.9.2 / 4.8.4 / 3.9.3 / 3.1.2 / 4.5.1 | |
| hyperswarm | 4.17.0 | 4.17.2 | |
| protomux | 3.11.0 | 3.12.1 | |
| blind-peer / blind-peering (dev) | 3.15.1 / 2.10.0 | 3.16.0 / 2.10.1 | |
| **brittle** (dev) | 3.19.1 | **4.5.0** | major, see below |
| **bare-subprocess** (dev) | 5.2.3 | **6.2.2** | major; used only by `test/next/net/dead-connection.js` on Bare, unchanged API there |
| **random-access-memory** (dev) | 3.1.4 | **6.2.1** | major; **unused** (Hypercore 11 stores in RocksDB): only the lead's `hypercore-clear-repro.js` requires it, without using it. Could be dropped |

Already latest: blind-pairing, codecs, compact-encoding, corestore 7.13.0, hyperbee 2.27.3, hypercore 11.37.2,
hypercore-crypto, hyperdb, hyperschema, index-encoder, keet-identity-key, protomux-wakeup, ready-resource, safety-catch,
sodium-universal, z32, bare 1.34.1, hyperdht 6.34.1. Ranges in package.json raised to the installed versions.

Transitive (`npm update`, 37 packages): e.g. udx-native 1.19.2 → 1.21.3, rocksdb-native 3.18.1 → 3.19.1,
hypercore-storage 3.3.1 → 3.3.2, @hyperswarm/secret-stream 6.9.1 → 6.9.2. One copy each of hypercore, corestore,
hyperdht, hyperbee, autobase, hyperswarm, protomux (`npm ls`, all deduped). Left behind only where a parent's range
forbids the next major: nanoassert 2 (hypercore, autobase, hyperdht, keet-identity-key), varint 5 (hyperbee's
protocol-buffers-encodings), record-cache 1 (hyperdht), bare-module 6 (brittle's coverage tool).

## What had to change

- **brittle 4**: the plain `brittle` command now runs tests on Bare (`brittle-node` for Node), and the bins moved
  (`bin/node.js`, `bin/bare.js` → `brittle-node.js`, `brittle-bare.js`). `scripts/test-runner.js`,
  `scripts/test-timeline.js` and package.json's `npx brittle` scripts follow; CLAUDE.md says so. Hooks changed meaning
  in 4 (`unhook = hook()`), but no test uses them.
- **Autobase 7.28.2** ("fix _teardown freeing the lock too early", autobase#378): `_close()` now calls
  `this.store.session()`, which throws `Corestore is closed` if the base's Corestore was closed first. v1's own close
  order is right (`hypergraph.close()` closes bases, then the caller its store), but four v1 tests closed a standalone
  base in a teardown that ran after the graph's store closed: they now close it first (`{ order: -1 }`).
  **hyperDNS's tests do the same in three files** (below). Nothing on Autobase's tracker about it.
- Found on the way: `scripts/test-runner.js` printed `FAIL undefined` when two workers waited for free memory and the
  queue emptied meanwhile. Fixed.

## Results

| suite | before (7e067ac, recorded) | after (this branch) |
|---|---|---|
| v1 `npm test` | 390/390 | 390/390 |
| `npm run test:next` (Node) | 272/272 | 273/273 (one new test: the Hypercore stall) |
| `npm run test:next:bare` | 271/271 | 272/272 |
| hyperDNS `npm test` (its checkout, links the main checkout = master) | 46/46 | 46/46 (unchanged code) |
| hyperDNS against this branch (scratch copy, `node_modules/hypergraph` → this worktree) | | **3 files crash** in teardown (`authority-private.js`, `authority.js`, `resolve-permission-gate.js`; 11 tests); the other 10 files pass. With Autobase 7.28.1 swapped in, those 3 pass (11/11) |

The hyperDNS crash: its tests close the graph and the store together (`Promise.allSettled([graph.close(),
store.close()])`) or close a graph in a teardown that runs after its store's. Its shipped code (`shell/lib/session.js`)
closes the graph first, so only its tests break. **Tibo (2026-10-15): keep Autobase 7.28.2**; a hyperDNS session fixes those teardowns (graph first, then store) before
this branch merges.
