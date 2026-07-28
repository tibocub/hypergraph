/**
 * Utility functions shared across the hypergraph module.
 */

const crypto = require('crypto')

/**
 * Convert a timestamp to a sortable string by padding with zeros.
 *
 * @param   {number} ts - Unix timestamp in milliseconds
 * @returns {string} Zero-padded 16-character string for sorting
 */
const toSortableTs = ts => String(ts).padStart(16, '0')

/**
 * Compute a stable hash for tag events (used for signature verification).
 * This matches the hash function used in hypergraph.js for signing tag events.
 *
 * @param {Object} event - The tag event
 * @returns {Buffer} SHA-256 hash digest
 */
const stableTagHash = (event) => {
  const payload = {
    entityId: event.entityId,
    tag: event.tag
  }

  const msg = {
    op: event.type,
    payload,
    author: event.author,
    timestamp: event.timestamp
  }

  return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
}

module.exports = { toSortableTs, stableTagHash, resolveOpenContexts }

/**
 * Resolve which open context(s) a context-scoped read should query, given
 * the caller's opts and the graph instance's full set of currently-open
 * contexts.
 *
 * Shared between GraphView (getEdges/getByTag/hasTag) and Hypergraph
 * (countEdgesIn/countEdgesOut) - see either call site for the full
 * rationale. In short: tags/relations are stored per-context, and silently
 * aggregating across every open context whenever the caller didn't name one
 * would let a query scoped to one context blend in data from a completely
 * unrelated context it never asked about. That's fine when at most one
 * context is open (nothing to disambiguate), but must be explicit once
 * there's more than one.
 *
 * @param {Map<string, Object>} contexts - keyHex -> ContextBase
 * @param {Object} [opts]
 * @param {string|string[]} [opts.context]
 * @param {boolean} [opts.allContexts]
 * @returns {Array<[string, Object]>} [keyHex, ContextBase] pairs
 */
function resolveOpenContexts (contexts, opts = {}) {
  if (opts.context !== undefined && opts.context !== null) {
    const keys = Array.isArray(opts.context) ? opts.context : [opts.context]
    const out = []
    for (const key of keys) {
      if (!contexts.has(key)) {
        throw new Error(`Context not opened on this graph instance: ${key}`)
      }
      out.push([key, contexts.get(key)])
    }
    return out
  }

  if (opts.allContexts === true) {
    return [...contexts]
  }

  if (contexts.size <= 1) {
    return [...contexts]
  }

  throw new Error(
    'Multiple contexts are open on this graph instance - pass { context } ' +
    '(a context key, or an array of them) to say which one(s) to query, ' +
    'or { allContexts: true } to explicitly query across all of them.'
  )
}
