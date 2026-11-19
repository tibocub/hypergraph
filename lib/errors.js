// HypergraphError: every error the public API throws, with a stable `code`
// apps can switch on.

const codes = Object.freeze(Object.fromEntries([
  'NOT_ALLOWED', 'NOT_FOUND', 'INVALID_RECORD', 'INVALID_TYPE', 'INCOMPATIBLE_TYPES', 'RULE_REJECTED',
  'INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_USED_UP', 'INVITE_REVOKED', 'DEVICE_REMOVED', 'CLOSED',
  'SUSPENDED', 'NOT_SUPPORTED', // hg.suspend(), hg.scope() before per-site keys
  'IMPORT_INVALID', // hg.importSpaces() of a pack missing or changed
  'CIRCLE_FULL', // a circle holds 50 members
  'MOVED', 'ALREADY_RENEWED' // a renewed space is read-only; another renew was decided first
].map((c) => [c, c])))

/**
 * Every error the public API throws, with a stable `code` apps can switch on (see `codes`).
 * Argument mistakes (a wrong type, a malformed option) throw a plain `TypeError` instead.
 * @property {string} code One of `codes`.
 */
class HypergraphError extends Error {
  constructor (code, message) {
    if (!codes[code]) throw new Error(`Unknown HypergraphError code: ${code}`)
    super(message)
    this.name = 'HypergraphError'
    this.code = code
  }
}

module.exports = { HypergraphError, codes }
