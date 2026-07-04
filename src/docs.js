/**
 * @fileoverview Hypergraph Documentation
 *
 * This file provides an overview of the Hypergraph system architecture and key concepts.
 */

/**
 * @overview Hypergraph Architecture
 *
 * Hypergraph is a minimal graph database optimized for P2P social apps on the Holepunch stack.
 * It is a thin composition over Hypercore, Corestore, Autobase and Hyperbee.
 *
 * ## Core Components
 *
 * - **UserCore**: Single-writer Hypercore storing user's identity and authored entities
 * - **ContextBase**: Multi-writer Autobase storing shared graph data (relations, tags, moderation)
 * - **RoleBase**: Manages access control and permissions for contexts
 * - **GraphView**: Materialized view combining data from all cores for efficient querying
 * - **GraphQuery**: Query builder for traversing the graph
 *
 * ## Data Model
 *
 * - **Entities**: Nodes in the graph (posts, profiles, etc.) stored in UserCore
 * - **Relations**: Edges connecting entities stored in ContextBase
 * - **Tags**: Labels attached to entities stored in ContextBase
 * - **Moderation**: Content moderation events stored in ContextBase
 *
 * ## Identity System
 *
 * Hypergraph uses a dual-key identity system:
 * - **Identity Key**: Long-term public key representing the user's identity
 * - **Device Key**: Ephemeral key per device for signing operations
 *
 * This allows multiple devices to share the same identity while maintaining device-specific
 * signing capabilities.
 *
 * ## Contexts and Roles
 *
 * Contexts are isolated graph spaces with their own access control:
 * - **Open contexts**: Anyone can write (e.g., public forums)
 * - **Closed contexts**: Only authorized writers can contribute (e.g., private groups)
 *
 * Roles define permissions within contexts:
 * - **Owner**: Full control including role management
 * - **Moderator**: Can perform moderation actions
 * - **Member**: Can read and write based on context settings
 *
 * ## Networking
 *
 * Hypergraph exposes a local graph API; networking is the responsibility of the application.
 * Typically done via Hyperswarm for P2P discovery and replication.
 *
 * ## Querying
 *
 * GraphQuery provides a fluent API for querying the graph:
 * - Filter by entity type, author, or custom criteria
 * - Traverse relations in any direction
 * - Limit and sort results
 * - Stream results for large datasets
 *
 * @module docs
 * @see {@link hypergraph}
 */
