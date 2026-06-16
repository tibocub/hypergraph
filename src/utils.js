/**
 * Utility functions shared across the hypergraph module.
 */

/**
 * Convert a timestamp to a sortable string by padding with zeros.
 *
 * @param   {number} ts - Unix timestamp in milliseconds
 * @returns {string} Zero-padded 16-character string for sorting
 */
const toSortableTs = ts => String(ts).padStart(16, '0')

module.exports = { toSortableTs }
