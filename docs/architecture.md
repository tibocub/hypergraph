# Architecture

This document has been split into focused files under `docs/contributors/`, to avoid
maintaining the same content in two places. Start here:

- [Architecture Overview](contributors/architecture-overview.md) - Component overview and responsibilities
- [Data Flow](contributors/data-flow.md) - How data flows through the system for each operation
- [Component Details](contributors/component-details.md) - Detailed internals of each component
- [Autobase Integration](contributors/autobase-integration.md) - How ContextBase/RoleBase/ScopeBase use Autobase
- [Corestore Namespaces](contributors/corestore-namespaces.md) - Namespacing rules, and a real bug caused by skipping them
- [Event Encoding](contributors/event-encoding.md) - Event format, encoding, and the full list of supported event types
- [Index Structure](contributors/index-structure.md) - Every index GraphView maintains, key by key
- [Replication Flow](contributors/replication-flow.md) - Manual replication and writer authorization
- [Multi-Device Support](contributors/multi-device-support.md) - Identity vs device vs encryption keys
- [Critical Implementation Details](contributors/critical-implementation-details.md) - Gotchas, edge cases, and things that have caused real bugs

## See Also

- [Contexts and Roles](contexts-and-roles.md) - Write-access model (roles, permissions, moderation)
- [Read Permission](read-permission.md) - Read-access model (scopes, key grants, content encryption)
- [Querying](querying.md) - The fluent query API
- [Networking](networking.md) - HypergraphNetwork and manual replication
- [Storage Model](storage-model.md) - How data is distributed across UserCore/ContextBase/RoleBase/GraphView
- [Glossary](glossary.md) - P2P and Holepunch terminology
