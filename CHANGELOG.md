# Changelog

All notable changes to Hypergraph will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
