/**
 * Utility functions shared across the hypergraph module.
 */

const crypto = require('crypto')

// Matches the 16-character zero-padded width below and stays within
// Number.MAX_SAFE_INTEGER, so a clamped value never loses precision.
const MAX_SORTABLE_TS = Number.MAX_SAFE_INTEGER // 9007199254740991 (16 digits)

/**
 * Convert a timestamp to a sortable string by padding with zeros.
 *
 * `ts` may come directly from a peer-controlled, self-signed event field
 * (relation/tag/entity timestamps) — clamped to a non-negative safe integer
 * first, since an unsanitized negative number (padStart puts the zeros
 * BEFORE the existing string, so the sign ends up mid-string, not at the
 * front) or an out-of-range one (renders in JS exponential notation, e.g.
 * "1e+21") would silently corrupt lexicographic ordering for every
 * time-sorted index without throwing.
 *
 * @param   {number} ts - Unix timestamp in milliseconds
 * @returns {string} Zero-padded 16-character string for sorting
 */
const toSortableTs = ts => {
  const n = Number(ts)
  const safe = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), MAX_SORTABLE_TS) : 0
  return String(safe).padStart(16, '0')
}

/**
 * Compute a stable hash for tag events (used for signature verification).
 * Shared between hypergraph.js (signing) and context-base.js (verifying) so
 * the two can never drift apart.
 *
 * `contextKeyHex` binds the signature to a specific context (its Autobase
 * key) — without this, a validly-signed tag/add or tag/remove event created
 * for one context carries an identical signature regardless of which
 * context it's actually appended into, so it can be replayed into any other
 * context the signer (or anyone else) has writer access to.
 *
 * @param {Object} event - The tag event
 * @param {string} [contextKeyHex] - Hex-encoded key of the context this event belongs to
 * @returns {Buffer} SHA-256 hash digest
 */
const stableTagHash = (event, contextKeyHex) => {
  const payload = {
    entityId: event.entityId,
    tag: event.tag,
    context: contextKeyHex || null
  }

  const msg = {
    op: event.type,
    payload,
    author: event.author,
    timestamp: event.timestamp
  }

  return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
}

/**
 * Compute a stable hash for relation events (used for signature
 * verification). Shared between hypergraph.js (signing) and
 * context-base.js (verifying) so the two can never drift apart — this used
 * to be a verbatim-duplicated private method in each file.
 *
 * `contextKeyHex` binds the signature to a specific context, same rationale
 * as stableTagHash above.
 *
 * @param {Object} event - The relation event
 * @param {string} [contextKeyHex] - Hex-encoded key of the context this event belongs to
 * @returns {Buffer} SHA-256 hash digest
 */
const stableRelationHash = (event, contextKeyHex) => {
  const payload = {
    from: event.from,
    to: event.to,
    relationType: event.relationType,
    value: typeof event.value === 'number' ? event.value : null,
    context: contextKeyHex || null
  }
  // Data on the relation (spec 004) is signed when present. Only then: a
  // relation without data keeps exactly its pre-spec-004 digest and
  // signature.
  if (typeof event.data === 'string') payload.data = event.data

  const msg = {
    op: event.type,
    payload,
    author: event.author,
    timestamp: event.timestamp
  }

  // For relation/delete, include createdAt
  if (event.createdAt) {
    msg.createdAt = event.createdAt
  }

  return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
}

/**
 * Stable hash for the signed context governance events of specs 005/006
 * (`context/writer`, `context/role`, `context/invite`, `context/redeem`),
 * bound to one context like relations.
 *
 * @param {Object} event
 * @param {string} contextKeyHex
 * @returns {Buffer} SHA-256 digest
 */
const stableContextHash = (event, contextKeyHex) => {
  let payload
  if (event.type === 'context/writer') payload = { key: event.key, member: event.member || '' }
  else if (event.type === 'context/invite') {
    payload = { inviteKey: event.inviteKey, role: event.role || '', uses: event.uses }
    // A scope request (spec 006 US3) is signed too; plain invites hash as before.
    if (event.scope) Object.assign(payload, { scope: event.scope, scopeBase: event.scopeBase || '', roleBase: event.roleBase || '' })
  } else if (event.type === 'context/redeem') {
    // Signed twice with this same digest, by the invite key (proves the
    // link) and by the member (binds the redemption, and the encryption key
    // a scope would be sealed to, to them).
    payload = { inviteKey: event.inviteKey, member: event.member, key: event.key }
    if (event.encryptionKey) payload.encryptionKey = event.encryptionKey
  }
  else payload = { member: event.member, role: event.role || '' }
  const msg = {
    op: event.type,
    payload,
    context: contextKeyHex || null,
    author: event.author,
    timestamp: event.timestamp
  }
  return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
}

// Largest data a relation may carry, in bytes of UTF-8 (spec 004): every
// member of a context may fetch it, and it lives in the index.
const MAX_RELATION_DATA_BYTES = 4096

/**
 * Whether `data` is acceptable relation data. Shared by the write path
 * (which throws) and apply (which rejects), so both enforce the same bound.
 *
 * @param {*} data
 * @returns {string|null} Why it is not acceptable, or null.
 */
const relationDataProblem = (data) => {
  if (data === undefined) return null
  if (typeof data !== 'string') return 'data must be a string'
  if (Buffer.byteLength(data, 'utf-8') > MAX_RELATION_DATA_BYTES) return `data must be at most ${MAX_RELATION_DATA_BYTES} bytes of UTF-8`
  return null
}

module.exports = { toSortableTs, stableTagHash, stableRelationHash, stableContextHash, resolveOpenContexts, authorFromEntityId, relationDataProblem, MAX_RELATION_DATA_BYTES }

/**
 * Extract the author (core key hex) embedded in an entity id.
 *
 * Entity ids are always formed as `${type}/${authorCoreKeyHex}/${seq}` (see
 * Hypergraph#put) — the author is the entity's own UserCore key, the exact
 * same key that appears in `event.author` on any tag/relation event that
 * identity signs. This makes it possible to check "does this id genuinely
 * belong to this claimed author" from the id string alone, with no entity
 * lookup and no dependency on having that author's UserCore open/replicated
 * locally at all.
 *
 * Splits from the end rather than assuming a fixed prefix, so an entity
 * `type` that itself happens to contain a `/` doesn't break parsing — only
 * the author (a hex string) and seq (an integer) are guaranteed slash-free.
 *
 * @param {string} id
 * @returns {string|null} The author hex, or null if `id` isn't a
 *   well-formed entity id (fewer than 2 `/`-separated segments).
 */
function authorFromEntityId (id) {
  if (typeof id !== 'string') return null
  const parts = id.split('/')
  if (parts.length < 3) return null
  return parts[parts.length - 2]
}

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
 * @returns {Array<Array>} [keyHex, ContextBase] pairs
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
