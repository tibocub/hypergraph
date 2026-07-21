// Pure state machine for read-scope events — mirrors roles-registry.js's
// design exactly (initRegistry/applyRoleEvent/can), applied to a different
// concern: this tracks WHO HAS BEEN SEALED WHICH KEY EPOCH for a given
// read-scope, not who has what role. The actual symmetric scope keys never
// appear anywhere in this registry — only sealed (crypto_box_seal) copies
// of them do, each one readable only by its intended recipient.
//
// One registry entry per scope, keyed by scope id. A single ScopeBase can
// host many independent scopes, the same way a single RoleBase can define
// many roles.

/**
 * Create the initial state for a brand-new scope.
 *
 * @param {string} scopeId - Unique id for this scope
 * @param {string} creatorPubkeyHex - The creator's hex public key
 * @returns {Object} Initial scope state
 * @throws {Error} If scopeId or creatorPubkeyHex is missing
 */
function initScope (scopeId, creatorPubkeyHex) {
  if (typeof scopeId !== 'string' || scopeId.length === 0) throw new Error('scopeId is required')
  if (typeof creatorPubkeyHex !== 'string' || creatorPubkeyHex.length === 0) throw new Error('creatorPubkeyHex is required')

  return {
    version: 1,
    id: scopeId,
    creator: creatorPubkeyHex,
    currentEpoch: 0,
    // `${pubkeyHex}:${epoch}` -> { sealedKey, granter, timestamp }
    grants: {},
    // pubkeyHex -> true. Informational marker that this pubkey is not a
    // current member — actual enforcement is simply that a revoked pubkey
    // stops receiving new keyGrant events at future epochs, not that this
    // flag is checked anywhere. Revocation can never retroactively undo a
    // grant this pubkey already received; that's an inherent property of
    // any offline-first system, not something this registry tries to paper
    // over.
    revoked: {}
  }
}

/**
 * Apply a scope event to a map of registries (one per scope id).
 *
 * Pure function: computes the next state from the current state and an
 * event, same contract as applyRoleEvent(). Unlike roles-registry.js
 * (which has exactly one registry per RoleBase), this operates over a map
 * of many scopes, since one ScopeBase hosts many independent scopes.
 *
 * @param {Object|null} registries - Current map of { [scopeId]: scopeState }, or null
 * @param {Object} event - The scope event to apply
 * @returns {Object} The next map of registries
 * @throws {Error} If the event type is invalid or required fields are missing
 */
function applyScopeEvent (registries, event) {
  if (!event || typeof event.type !== 'string') throw new Error('event.type is required')

  const next = registries && typeof registries === 'object' ? { ...registries } : {}

  switch (event.type) {
    case 'scope/create': {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) throw new Error('event.scopeId is required')
      if (typeof event.creator !== 'string' || event.creator.length === 0) throw new Error('event.creator is required')
      // Idempotent: creating an already-existing scope id is a no-op on
      // the existing state, not an overwrite — a scope's identity/creator
      // shouldn't be replaceable by a later, possibly conflicting event of
      // the same type replicated out of order.
      if (next[event.scopeId]) return next
      next[event.scopeId] = initScope(event.scopeId, event.creator)
      return next
    }

    case 'scope/keyGrant': {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) throw new Error('event.scopeId is required')
      if (typeof event.recipient !== 'string' || event.recipient.length === 0) throw new Error('event.recipient is required')
      if (typeof event.epoch !== 'number' || event.epoch < 0) throw new Error('event.epoch must be a non-negative number')
      if (typeof event.sealedKey !== 'string' || event.sealedKey.length === 0) throw new Error('event.sealedKey is required')

      const scope = next[event.scopeId]
      if (!scope) return next // grant for an unknown scope — ignore rather than throw, matches roles-registry's tolerance for out-of-order replication

      const updated = {
        ...scope,
        grants: { ...scope.grants },
        revoked: { ...scope.revoked }
      }
      updated.grants[`${event.recipient}:${event.epoch}`] = {
        sealedKey: event.sealedKey,
        granter: event.granter || null,
        timestamp: typeof event.timestamp === 'number' ? event.timestamp : null
      }
      // A fresh grant supersedes any earlier revocation marker for this
      // recipient — they're a current member again as of this epoch.
      delete updated.revoked[event.recipient]
      if (event.epoch > updated.currentEpoch) updated.currentEpoch = event.epoch

      next[event.scopeId] = updated
      return next
    }

    case 'scope/revoke': {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) throw new Error('event.scopeId is required')
      if (typeof event.pubkey !== 'string' || event.pubkey.length === 0) throw new Error('event.pubkey is required')

      const scope = next[event.scopeId]
      if (!scope) return next

      next[event.scopeId] = {
        ...scope,
        revoked: { ...scope.revoked, [event.pubkey]: true }
      }
      return next
    }

    default:
      return next
  }
}

/**
 * Look up a specific recipient's sealed key grant for a scope at a given
 * epoch.
 *
 * @param {Object|null} registries - Map of { [scopeId]: scopeState }
 * @param {string} scopeId - The scope id
 * @param {string} pubkeyHex - The recipient's hex public key
 * @param {number} epoch - The epoch to look up
 * @returns {Object|null} The grant record ({ sealedKey, granter, timestamp }), or null if none exists
 */
function getGrant (registries, scopeId, pubkeyHex, epoch) {
  if (!registries || typeof registries !== 'object') return null
  const scope = registries[scopeId]
  if (!scope || !scope.grants) return null
  return scope.grants[`${pubkeyHex}:${epoch}`] || null
}

module.exports = {
  initScope,
  applyScopeEvent,
  getGrant
}
