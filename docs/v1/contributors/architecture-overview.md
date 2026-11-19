# Architecture Overview

Hypergraph is composed of the following core components:

```
Hypergraph (main entry point)
├── UserCore (single-writer Hypercore for entities/content)
├── ContextBase (multi-writer Autobase for relations/tags/moderation)
├── RoleBase (Autobase for role registry and permissions)
├── ScopeBase (Autobase for read-permission key grants)
├── GraphView (Hyperbee materialized view with indexes)
├── IdentityManager (keet-identity-key wrapper for multi-device support)
├── GraphQuery (fluent query interface)
└── HypergraphNetwork (separate class — networking helper, not part of Hypergraph itself)
```

Note: there is no separate "PeerDiscovery" component — peer join/leave events are emitted by
`HypergraphNetwork`, not by `Hypergraph` itself. `Hypergraph.on()` only ever emits `'change'`
and throws for any other event name — see [Networking](../networking.md).

## Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| Hypergraph | `src/hypergraph.js` | Main API, coordinates all components |
| UserCore | `src/user-core.js` | Manages user's personal Hypercore (entities, content) |
| ContextBase | `src/context-base.js` | Manages collaborative Autobase contexts |
| RoleBase | `src/role-base.js` | Manages role-based access control |
| ScopeBase | `src/scope-base.js` | Manages read-permission scopes and sealed key grants |
| GraphView | `src/view.js` | Materialized view with Hyperbee indexes |
| IdentityManager | `src/identity-manager.js` | Identity, device key, and encryption key management |
| GraphQuery | `src/query.js` | Fluent query interface |
| RolesRegistry | `src/roles-registry.js` | Role permission checking logic (pure state machine) |
| ScopesRegistry | `src/scopes-registry.js` | Scope/key-grant tracking logic (pure state machine) |
| HypergraphNetwork | `src/networking.js` | Networking helper: bootstrap exchange, writer-request/grant handshake, peer-join/leave events (separate from `Hypergraph` itself) |

## See Also

- [Data Flow](data-flow.md) - How data flows through the system
- [Component Details](component-details.md) - Detailed internals of each component
- [Networking](../networking.md) - HypergraphNetwork and the manual replication alternative
