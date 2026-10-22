// HypergraphError: every error the public API throws, with a stable `code`
// apps can switch on (contracts/api.md, "Error codes").

const codes = Object.freeze(Object.fromEntries([
  'NOT_ALLOWED', 'NOT_FOUND', 'INVALID_RECORD', 'INVALID_TYPE', 'INCOMPATIBLE_TYPES', 'RULE_REJECTED',
  'INVITE_INVALID', 'INVITE_EXPIRED', 'INVITE_USED_UP', 'INVITE_REVOKED', 'DEVICE_REMOVED', 'CLOSED'
].map((c) => [c, c])))

class HypergraphError extends Error {
  constructor (code, message) {
    if (!codes[code]) throw new Error(`Unknown HypergraphError code: ${code}`)
    super(message)
    this.name = 'HypergraphError'
    this.code = code
  }
}

module.exports = { HypergraphError, codes }
