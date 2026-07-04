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

module.exports = { toSortableTs, stableTagHash }
