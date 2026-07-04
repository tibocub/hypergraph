# Changelog

All notable changes to Hypergraph will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Test suite refactor (from-scratch rewrite, no backward compatibility)
Rewrote the entire test suite from scratch to test the intended, current API rather than
legacy/historical behavior. Old ad-hoc test files (`basic.js`, `identity.js`, `ordering.js`,
`moderation.js`, `integration.js`, `hyperswarm.js`, `networking.js`, and the non-brittle
`replication-scenarios.js` script) were removed and replaced with:
- `test/brittle/core/` — entities, identity-manager, identity-graph, contexts, relations,
  tags, query, roles, moderation, events. All run locally with no network access and are
  fully verified (60 tests, 143 assertions).
- `test/brittle/networking/` — HypergraphNetwork, peer connection, bootstrap/export,
  connectToSwarm. Two files (`bootstrap-export.js`, most of `connect-to-swarm.js`) run
  locally; the rest need a real Hyperswarm/DHT connection.
- `test/brittle/replication/` — late-joiner, concurrent-writes, peer-reconnection,
  HypergraphNetwork integration. All need a real DHT connection to run.
- `test/brittle/integration/full-app-flow.js` — a single-process end-to-end flow through
  identity, entities, content, relations, tags, roles, moderation, query, and export/join.
- `test/brittle/forum/` — unchanged, still passing (12 tests, 43 assertions).

npm scripts were reorganized into one script per test module (`npm run test:entities`,
`test:roles`, `test:queries`, `test:moderation`, `test:replication`, etc.) plus grouped
scripts (`test:core`, `test:networking`, `test:replication`) and a top-level `npm test`
that runs everything. See `package.json`.

Per-module perf/stress tests remain deliberately out of scope for now (moderation stress
scenarios); reliability/correctness is the current focus.

### Fixed
Writing real tests against the actual API surface (rather than through the historical
happy-path scripts) surfaced several previously-undetected bugs, none of which had any
test coverage before this refactor:
- **`getRole()` always crashed.** It read a non-existent `RoleBase.view` property; fixed
  to use the existing `getRegistry()` accessor (same one `can()` already used correctly).
- **`GraphQuery.tag()` always returned zero results.** It queried the top-level graph
  view's own Hyperbee, but tag refs are written into each context's own per-context
  Hyperbee. Added `GraphView.hasTag()` and pointed `.tag()` at it.
- **`GraphQuery.reverse()` did nothing.** The `#reverse` flag was set but never read
  anywhere in the iterator; now passed through to the underlying `createReadStream`.
- **`IdentityManager.init()` never awaited `bootstrap()`**, even though it's an async
  method, so `attestationProof` silently held a `Promise` instead of a real proof. Only
  surfaced once something tried to actually use the proof (e.g. `attestDevice()`), which
  then crashed. Old tests only checked truthiness, which a Promise also satisfies.
- **`putContent()` accepted content for entities that don't exist.** Now throws
  `Entity not found`, matching `del()`'s existing behavior, instead of silently writing
  orphaned content events.
- **`connectToSwarm()` always threw `"Topic is required"`.** It passed the options object
  as the 3rd positional constructor argument (`swarm`) instead of passing `swarm` and
  `opts` separately, so `HypergraphNetwork` never actually received a `topic`. Also never
  auto-created a Hyperswarm when `opts.swarm` was omitted, despite the docstring promising
  it would; both are fixed.
- **Two redundant `openRoleBase()` calls crashed with `"Autobase failed to open"`.**
  `createRoleBase()` already attaches the created RoleBase to the graph; calling
  `openRoleBase()` again immediately afterward (previously present in three moderation
  tests) closed and reopened it, crashing Autobase. Removed the redundant calls.

### Removed (no backward compatibility)
- `Hypergraph#announce()`, `#discoverPeers()`, `#listPeers()` — dead no-ops kept only for
  backward compatibility. Peer discovery is exclusively `HypergraphNetwork`'s
  responsibility now (`peer-join`/`peer-leave` events on the `HypergraphNetwork` instance).
- `Hypergraph#handlePeerDisconnection()` — also a dead no-op with the same rationale.
- `Hypergraph#on()`/`#off()` no longer silently accept arbitrary event names. They only
  support `'change'` (the only event Hypergraph itself ever emits) and now throw for
  anything else — including `'peer-join'`/`'peer-leave'`, which were never actually wired
  up to fire on `Hypergraph` (only `HypergraphNetwork` emits those). Previously, code that
  called `graph.on('peer-join', ...)` would register a listener that could never fire,
  with no error to indicate the mistake.
- The stale `PeerDiscovery` JSDoc typedef in `src/types.js`, describing a module that was
  already deleted in a previous refactor.

### Known gaps (deliberately left unaddressed for now)
- Closed-mode context write authorization (`test/brittle/core/contexts.js`, two skipped
  tests) requires a peer to already be a writer before opening an existing context, which
  conflicts with Autobase's open-then-authorize model. This needs an application-level
  redesign (role check gating `addWriter`/`append`), not a test fix. Tracked for follow-up.
- Moderation stress/perf scenarios (many flaggers, adversarial spam, competing trust sets)
  remain skipped; out of scope until the moderation event model has stabilized.

### Added
- Contributor documentation in `docs/architecture.md` with low-level architecture details
- Platform-specific considerations section to README for Windows file locking issues
- **HypergraphNetwork class**: New networking helper with dual swarm setup (data + control)
  - Accepts Hyperswarm instance as parameter (follows holepunch pattern)
  - Creates control swarm internally, sharing DHT from passed swarm
  - Context keys (not instances) to avoid timing problems
  - JSON protocol for writer authorization on control swarm
  - Static `generateBootstrap()` method for bootstrap.json generation
  - Exposes Hyperswarm's native peer discovery events
- **Bootstrap generation**: `HypergraphNetwork.generateBootstrap(graph, opts)` static method

### Changed
- **Renamed**: `HypergraphNetworking` → `HypergraphNetwork`
- **Dual swarm approach**: Data swarm for replication, control swarm for JSON protocol
- **Context integration**: Accept context keys, open contexts internally
- **Writer authorization**: Any writer can add writers (no owner required)
- **Peer discovery**: Removed `PeerDiscovery` module, use Hyperswarm's native events
- **Deprecated**: `graph.announce()`, `graph.discoverPeers()`, `graph.listPeers()` (kept for backward compatibility)

### Removed
- **PeerDiscovery module**: `src/peer-discovery.js` deleted (placeholder code)
- **Graph-level peer discovery**: Now handled by HypergraphNetwork using Hyperswarm

### Fixed
- **RoleBase opening errors**: Removed redundant `openRoleBase()` calls after `createRoleBase()` in forum brittle tests and examples/forum/owner.js. `createRoleBase()` already attaches the RoleBase to the graph instance; calling `openRoleBase()` again causes "Autobase failed to open" errors.
  - Fixed in: `test/brittle/forum/scenarios/moderation-propagation.js`
  - Fixed in: `test/brittle/forum/scenarios/out-of-order-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/partial-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/idempotency.js`
  - Fixed in: `test/brittle/forum/scenarios/moderation-conflict.js`
  - Fixed in: `test/brittle/forum/scenarios/cross-context-integrity.js`
  - Fixed in: `examples/forum/owner.js`

- **Concurrent writes test flakiness**: Changed from concurrent writes to sequential writes with explicit DHT announcement timing. Peers must announce on DHT before creating data for reliable peer discovery.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Windows cleanup EPERM errors**: Added retry logic with exponential backoff (10 retries, 500ms * attempt delay) for directory cleanup to handle Windows file locking issues.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Relay replication test failure**: Ensured Peer A announces on DHT before creating data and added proper replication waits.
  - Fixed in: `test/brittle/replication-scenarios.js`

### Changed
- Updated README to correct Bootstrap/Export API return value structure

### Fixed
- **RoleBase opening errors**: Removed redundant `openRoleBase()` calls after `createRoleBase()` in forum brittle tests and examples/forum/owner.js. `createRoleBase()` already attaches the RoleBase to the graph instance; calling `openRoleBase()` again causes "Autobase failed to open" errors.
  - Fixed in: `test/brittle/forum/scenarios/moderation-propagation.js`
  - Fixed in: `test/brittle/forum/scenarios/out-of-order-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/partial-replication.js`
  - Fixed in: `test/brittle/forum/scenarios/idempotency.js`
  - Fixed in: `test/brittle/forum/scenarios/moderation-conflict.js`
  - Fixed in: `test/brittle/forum/scenarios/cross-context-integrity.js`
  - Fixed in: `examples/forum/owner.js`

- **Concurrent writes test flakiness**: Changed from concurrent writes to sequential writes with explicit DHT announcement timing. Peers must announce on DHT before creating data for reliable peer discovery.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Windows cleanup EPERM errors**: Added retry logic with exponential backoff (10 retries, 500ms * attempt delay) for directory cleanup to handle Windows file locking issues.
  - Fixed in: `test/brittle/replication-scenarios.js`

- **Relay replication test failure**: Ensured Peer A announces on DHT before creating data and added proper replication waits.
  - Fixed in: `test/brittle/replication-scenarios.js`

### Changed
- Updated README to correct Bootstrap/Export API return value structure
- Removed incorrect `moderateAction()` and `queryContext()` examples from Quickstart (these are lower-level APIs)
- Added "Creating vs Opening RoleBase" section to README
- Added "DHT Announcement Timing" section to README

## [0.0.1] - Initial Prototype

### Added
- Core graph database functionality with entities, relations, tags, and content
- Identity system with mnemonic recovery and multi-device support
- Collaborative contexts with open and closed write modes
- Role-based access control system (RoleBase)
- Materialized view with Hyperbee indexes
- Fluent query interface
- Peer discovery event emission
- Bootstrap/export API for joining existing graphs
- Forum example application with moderation
- CLI chat example

### Architecture
- UserCore: Single-writer Hypercore per user for entities and content
- ContextBase: Multi-writer Autobase for relations, tags, and moderation
- RoleBase: Autobase for role registry and permissions
- GraphView: Hyperbee materialized view with indexes
- IdentityManager: keet-identity-key wrapper for identity management
- PeerDiscovery: Event emitter for peer join/leave events

### Dependencies
- Hypercore: Append-only logs for data storage
- Corestore: Core management and namespace isolation
- Autobase: Multi-writer CRDT for collaborative contexts
- Hyperbee: Materialized view and key-value indexes
- keet-identity-key: Identity management with mnemonic recovery
