# Architecture Overview

Hypergraph is composed of the following core components:

```
Hypergraph (main entry point)
├── UserCore (single-writer Hypercore for entities/content)
├── ContextBase (multi-writer Autobase for relations/tags/moderation)
├── RoleBase (Autobase for role registry and permissions)
├── GraphView (Hyperbee materialized view with indexes)
├── IdentityManager (keet-identity-key wrapper for multi-device support)
├── PeerDiscovery (event emitter for peer join/leave)
└── GraphQuery (fluent query interface)
```

## Component Responsibilities

| Component | File | Responsibility |
|-----------|------|----------------|
| Hypergraph | `src/hypergraph.js` | Main API, coordinates all components |
| UserCore | `src/user-core.js` | Manages user's personal Hypercore (entities, content) |
| ContextBase | `src/context-base.js` | Manages collaborative Autobase contexts |
| RoleBase | `src/role-base.js` | Manages role-based access control |
| GraphView | `src/view.js` | Materialized view with Hyperbee indexes |
| IdentityManager | `src/identity-manager.js` | Identity and device key management |
| PeerDiscovery | `src/peer-discovery.js` | Peer join/leave event emission |
| GraphQuery | `src/query.js` | Fluent query interface |
| RolesRegistry | `src/roles-registry.js` | Role permission checking logic |

## See Also

- [Data Flow](data-flow.md) - How data flows through the system
- [Component Details](component-details.md) - Detailed internals of each component
