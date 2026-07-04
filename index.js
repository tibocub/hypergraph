const Hypergraph = require('./src/hypergraph')
const UserCore = require('./src/user-core')
const ContextBase = require('./src/context-base')
const RoleBase = require('./src/role-base')
const GraphView = require('./src/view')
const GraphQuery = require('./src/query')
const HypergraphNetwork = require('./src/networking')
//const tools = require('./tools')

/**
 * Hypergraph - A minimal graph database optimized for P2P social apps.
 *
 * @module hypergraph
 * @description
 * Built with a focus on ease of use and compatibility with hyperswarm and the Holepunch ecosystem.
 * Provides basic graph store operations, cryptographic user ID system, and role-based moderation.
 *
 * @example
 * const { Hypergraph } = require('hypergraph')
 * const Corestore = require('corestore')
 *
 * const store = new Corestore('./data')
 * const graph = new Hypergraph(store)
 * await graph.ready()
 *
 * @property {typeof Hypergraph} Hypergraph - Main graph database class
 * @property {typeof UserCore} UserCore - User core wrapper for event storage
 * @property {typeof ContextBase} ContextBase - Collaborative context using Autobase
 * @property {typeof RoleBase} RoleBase - Role-based access control system
 * @property {typeof GraphView} GraphView - Materialized view for graph operations
 * @property {typeof GraphQuery} GraphQuery - Query builder for graph traversal
 * @property {typeof HypergraphNetwork} HypergraphNetwork - Helper class for Hyperswarm integration
 * @property {Object} tools - Developer tools and utilities
 */
module.exports = {
  Hypergraph,
  UserCore,
  ContextBase,
  RoleBase,
  GraphView,
  GraphQuery,
  HypergraphNetwork,
  // tools
}
