const c = require('compact-encoding')
const b4a = require('b4a')

/**
 * Compact encoding/decoding for hypergraph events.
 *
 * Provides binary encoding for graph events to minimize storage and transmission overhead.
 * Supports entity creation, content append, relations, tags, identity updates, and more.
 */

// Event type constants - map from string to code
const EVENT_TYPES = {
  'entity/create': 1,
  'entity/tombstone': 2,
  'content/append': 3,
  'relation/create': 4,
  'relation/delete': 5,
  'tag/add': 6,
  'tag/remove': 7,
  'identity/update': 8,
  'addWriter': 9,
  'roles/addWriter': 10,
  'moderation/action': 11,
  'message': 12,
  'roles/removeWriter': 13,
  'context/init': 14,
  'context/writer': 15,
  'context/role': 16,
  'context/upgrade': 17,
  'context/invite': 18,
  'context/redeem': 19
}

// Map from code to string
const EVENT_TYPE_NAMES = {
  1: 'entity/create',
  2: 'entity/tombstone',
  3: 'content/append',
  4: 'relation/create',
  5: 'relation/delete',
  6: 'tag/add',
  7: 'tag/remove',
  8: 'identity/update',
  9: 'addWriter',
  10: 'roles/addWriter',
  11: 'moderation/action',
  12: 'message',
  13: 'roles/removeWriter',
  14: 'context/init',
  15: 'context/writer',
  16: 'context/role',
  17: 'context/upgrade',
  18: 'context/invite',
  19: 'context/redeem'
}

// Compact encoding for events
const eventEncoding = {
  preencode (state, event) {
    c.uint.preencode(state, EVENT_TYPES[event.type] || 0)
    c.uint.preencode(state, event.timestamp || 0)

    switch (event.type) {
      case 'entity/create':
        c.string.preencode(state, event.id)
        c.string.preencode(state, event.entityType)
        c.string.preencode(state, event.author)
        break

      case 'entity/tombstone':
        c.string.preencode(state, event.id)
        c.string.preencode(state, event.author)
        break

      case 'content/append':
        c.string.preencode(state, event.entityId)
        c.string.preencode(state, event.contentType)
        c.string.preencode(state, event.body)
        c.uint.preencode(state, event.encrypted === true ? 1 : 0)
        if (event.encrypted === true) {
          c.string.preencode(state, event.scope)
          c.uint.preencode(state, event.epoch)
          c.string.preencode(state, event.nonce)
        }
        break

      case 'relation/create':
        c.string.preencode(state, event.from)
        c.string.preencode(state, event.to)
        c.string.preencode(state, event.relationType)
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        c.uint.preencode(state, typeof event.value === 'number' ? 1 : 0)
        if (typeof event.value === 'number') c.float64.preencode(state, event.value)
        // Optional trailing data (spec 004). Written only when present, so
        // relations without data keep exactly their old bytes.
        if (typeof event.data === 'string') {
          c.uint.preencode(state, 1)
          c.string.preencode(state, event.data)
        }
        break

      case 'relation/delete':
        c.string.preencode(state, event.from)
        c.string.preencode(state, event.to)
        c.string.preencode(state, event.relationType)
        c.string.preencode(state, event.author)
        c.uint.preencode(state, event.createdAt || 0)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'tag/add':
      case 'tag/remove':
        c.string.preencode(state, event.entityId)
        c.string.preencode(state, event.tag)
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'identity/update':
        c.string.preencode(state, event.author)
        c.string.preencode(state, event.username)
        c.string.preencode(state, event.bio || '')
        break

      case 'addWriter':
      case 'roles/addWriter':
      case 'roles/removeWriter':
        c.string.preencode(state, event.key)
        if (event.author) c.string.preencode(state, event.author)
        if (event.timestamp) c.uint.preencode(state, event.timestamp)
        if (event.signature) c.buffer.preencode(state, b4a.from(event.signature, 'hex'))
        break

      case 'moderation/action':
        c.uint.preencode(state, event.version || 1)
        c.string.preencode(state, event.action)
        c.string.preencode(state, event.target)
        c.string.preencode(state, event.reason || '')
        c.string.preencode(state, event.context || '')
        c.string.preencode(state, event.author)
        c.uint.preencode(state, event.timestamp)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/init':
        c.uint.preencode(state, event.version)
        c.string.preencode(state, event.rules || '')
        // Optional trailing owner (spec 005): version 2 records keep their bytes.
        // Then an optional index layout (spec 002), which needs the owner
        // slot written first ('' when there is none).
        if (typeof event.owner === 'string' || typeof event.layout === 'number') c.string.preencode(state, event.owner || '')
        if (typeof event.layout === 'number') c.uint.preencode(state, event.layout)
        break

      case 'context/writer':
        c.string.preencode(state, event.key)
        c.string.preencode(state, event.member || '')
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/role':
        c.string.preencode(state, event.member)
        c.string.preencode(state, event.role || '')
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/upgrade':
        c.uint.preencode(state, event.version)
        c.string.preencode(state, event.owner)
        break

      case 'context/invite':
        c.string.preencode(state, event.inviteKey)
        c.string.preencode(state, event.role || '')
        c.uint.preencode(state, event.uses)
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/redeem':
        c.string.preencode(state, event.inviteKey)
        c.string.preencode(state, event.member)
        c.string.preencode(state, event.key)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        c.buffer.preencode(state, event.memberSignature ? b4a.from(event.memberSignature, 'hex') : b4a.alloc(0))
        break

      case 'message':
        c.string.preencode(state, event.text)
        c.string.preencode(state, event.username)
        c.string.preencode(state, event.author)
        break
    }
  },

  encode (state, event) {
    c.uint.encode(state, EVENT_TYPES[event.type] || 0)
    c.uint.encode(state, event.timestamp || 0)

    switch (event.type) {
      case 'entity/create':
        c.string.encode(state, event.id)
        c.string.encode(state, event.entityType)
        c.string.encode(state, event.author)
        break

      case 'entity/tombstone':
        c.string.encode(state, event.id)
        c.string.encode(state, event.author)
        break

      case 'content/append':
        c.string.encode(state, event.entityId)
        c.string.encode(state, event.contentType)
        c.string.encode(state, event.body)
        c.uint.encode(state, event.encrypted === true ? 1 : 0)
        if (event.encrypted === true) {
          c.string.encode(state, event.scope)
          c.uint.encode(state, event.epoch)
          c.string.encode(state, event.nonce)
        }
        break

      case 'relation/create':
        c.string.encode(state, event.from)
        c.string.encode(state, event.to)
        c.string.encode(state, event.relationType)
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        c.uint.encode(state, typeof event.value === 'number' ? 1 : 0)
        if (typeof event.value === 'number') c.float64.encode(state, event.value)
        if (typeof event.data === 'string') {
          c.uint.encode(state, 1)
          c.string.encode(state, event.data)
        }
        break

      case 'relation/delete':
        c.string.encode(state, event.from)
        c.string.encode(state, event.to)
        c.string.encode(state, event.relationType)
        c.string.encode(state, event.author)
        c.uint.encode(state, event.createdAt || 0)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'tag/add':
      case 'tag/remove':
        c.string.encode(state, event.entityId)
        c.string.encode(state, event.tag)
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'identity/update':
        c.string.encode(state, event.author)
        c.string.encode(state, event.username)
        c.string.encode(state, event.bio || '')
        break

      case 'addWriter':
      case 'roles/addWriter':
      case 'roles/removeWriter':
        c.string.encode(state, event.key)
        if (event.author) c.string.encode(state, event.author)
        if (event.timestamp) c.uint.encode(state, event.timestamp)
        if (event.signature) c.buffer.encode(state, b4a.from(event.signature, 'hex'))
        break

      case 'moderation/action':
        c.uint.encode(state, event.version || 1)
        c.string.encode(state, event.action)
        c.string.encode(state, event.target)
        c.string.encode(state, event.reason || '')
        c.string.encode(state, event.context || '')
        c.string.encode(state, event.author)
        c.uint.encode(state, event.timestamp)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/init':
        c.uint.encode(state, event.version)
        c.string.encode(state, event.rules || '')
        if (typeof event.owner === 'string' || typeof event.layout === 'number') c.string.encode(state, event.owner || '')
        if (typeof event.layout === 'number') c.uint.encode(state, event.layout)
        break

      case 'context/writer':
        c.string.encode(state, event.key)
        c.string.encode(state, event.member || '')
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/role':
        c.string.encode(state, event.member)
        c.string.encode(state, event.role || '')
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/upgrade':
        c.uint.encode(state, event.version)
        c.string.encode(state, event.owner)
        break

      case 'context/invite':
        c.string.encode(state, event.inviteKey)
        c.string.encode(state, event.role || '')
        c.uint.encode(state, event.uses)
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        break

      case 'context/redeem':
        c.string.encode(state, event.inviteKey)
        c.string.encode(state, event.member)
        c.string.encode(state, event.key)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
        c.buffer.encode(state, event.memberSignature ? b4a.from(event.memberSignature, 'hex') : b4a.alloc(0))
        break

      case 'message':
        c.string.encode(state, event.text)
        c.string.encode(state, event.username)
        c.string.encode(state, event.author)
        break
    }
  },

  decode (state) {
    const typeCode = c.uint.decode(state)
    const timestamp = c.uint.decode(state)
    const type = EVENT_TYPE_NAMES[typeCode]

    const event = { type, timestamp }

    switch (type) {
      case 'entity/create':
        event.id = c.string.decode(state)
        event.entityType = c.string.decode(state)
        event.author = c.string.decode(state)
        break

      case 'entity/tombstone':
        event.id = c.string.decode(state)
        event.author = c.string.decode(state)
        break

      case 'content/append':
        event.entityId = c.string.decode(state)
        event.contentType = c.string.decode(state)
        event.body = c.string.decode(state)
        // Backward compat: events encoded before this field existed
        // don't have these trailing bytes at all — decoding them must not
        // crash (same pattern as relation/create's value field, round 33).
        if (state.start < state.end && c.uint.decode(state) === 1) {
          event.encrypted = true
          event.scope = c.string.decode(state)
          event.epoch = c.uint.decode(state)
          event.nonce = c.string.decode(state)
        }
        break

      case 'relation/create':
        event.from = c.string.decode(state)
        event.to = c.string.decode(state)
        event.relationType = c.string.decode(state)
        event.author = c.string.decode(state)
        const sig1 = c.buffer.decode(state)
        event.signature = sig1.length > 0 ? sig1.toString('hex') : null
        // Backward compat: events encoded before the value field existed
        // don't have these trailing bytes at all — decoding them must not
        // crash. Confirmed necessary in practice, not just in theory: a
        // real deployment hit "Out of bounds" here on already-persisted
        // data the moment this field was added.
        event.value = (state.start < state.end && c.uint.decode(state) === 1) ? c.float64.decode(state) : undefined
        // Data on the relation (spec 004): same trailing-bytes guard. An older
        // decoder stops above and never sees it.
        if (state.start < state.end && c.uint.decode(state) === 1) event.data = c.string.decode(state)
        break

      case 'relation/delete':
        event.from = c.string.decode(state)
        event.to = c.string.decode(state)
        event.relationType = c.string.decode(state)
        event.author = c.string.decode(state)
        event.createdAt = c.uint.decode(state)
        const sig2 = c.buffer.decode(state)
        event.signature = sig2.length > 0 ? sig2.toString('hex') : null
        break

      case 'tag/add':
      case 'tag/remove':
        event.entityId = c.string.decode(state)
        event.tag = c.string.decode(state)
        event.author = c.string.decode(state)
        const sig3 = c.buffer.decode(state)
        event.signature = sig3.length > 0 ? sig3.toString('hex') : null
        break

      case 'identity/update':
        event.author = c.string.decode(state)
        event.username = c.string.decode(state)
        event.bio = c.string.decode(state) || null
        break

      case 'addWriter':
      case 'roles/addWriter':
      case 'roles/removeWriter':
        event.key = c.string.decode(state)
        if (state.end > state.start) {
          // Check if there are more fields (author, timestamp, signature)
          // These fields are optional for backward compatibility.
          // Try-catch handles old formats (key only, or key+author+timestamp
          // without a signature) alongside the current format.
          try {
            event.author = c.string.decode(state)
            if (state.end > state.start) {
              event.timestamp = c.uint.decode(state)
              if (state.end > state.start) {
                const sig = c.buffer.decode(state)
                event.signature = sig.length > 0 ? sig.toString('hex') : null
              }
            }
          } catch {
            // No more fields - old format event
          }
        }
        break

      case 'moderation/action':
        event.version = c.uint.decode(state)
        event.action = c.string.decode(state)
        event.target = c.string.decode(state)
        event.reason = c.string.decode(state) || null
        event.context = c.string.decode(state) || null
        event.author = c.string.decode(state)
        event.timestamp = c.uint.decode(state)
        const sig4 = c.buffer.decode(state)
        event.signature = sig4.length > 0 ? sig4.toString('hex') : null
        break

      case 'context/init':
        // The context's own record of how it is applied: its topology
        // version and app rules id (spec 003, data-model.md).
        event.version = c.uint.decode(state)
        event.rules = c.string.decode(state)
        if (state.start < state.end) {
          const owner = c.string.decode(state)
          if (owner.length > 0) event.owner = owner
        }
        if (state.start < state.end) event.layout = c.uint.decode(state)
        break

      // Roles inside the context (spec 005).
      case 'context/writer': {
        event.key = c.string.decode(state)
        event.member = c.string.decode(state)
        event.author = c.string.decode(state)
        const sig = c.buffer.decode(state)
        event.signature = sig.length > 0 ? sig.toString('hex') : null
        break
      }

      case 'context/role': {
        event.member = c.string.decode(state)
        event.role = c.string.decode(state)
        event.author = c.string.decode(state)
        const sig = c.buffer.decode(state)
        event.signature = sig.length > 0 ? sig.toString('hex') : null
        break
      }

      case 'context/upgrade':
        event.version = c.uint.decode(state)
        event.owner = c.string.decode(state)
        break

      // Invites (spec 006).
      case 'context/invite': {
        event.inviteKey = c.string.decode(state)
        event.role = c.string.decode(state)
        event.uses = c.uint.decode(state)
        event.author = c.string.decode(state)
        const sig = c.buffer.decode(state)
        event.signature = sig.length > 0 ? sig.toString('hex') : null
        break
      }

      case 'context/redeem': {
        event.inviteKey = c.string.decode(state)
        event.member = c.string.decode(state)
        event.key = c.string.decode(state)
        const sig = c.buffer.decode(state)
        event.signature = sig.length > 0 ? sig.toString('hex') : null
        const msig = c.buffer.decode(state)
        event.memberSignature = msig.length > 0 ? msig.toString('hex') : null
        break
      }

      case 'message':
        event.text = c.string.decode(state)
        event.username = c.string.decode(state)
        event.author = c.string.decode(state)
        break
    }

    return event
  }
}

/**
 * Encode an event to a binary buffer.
 *
 * @param {Object} event - The event to encode
 * @returns {Buffer} The encoded event as a Buffer
 */
function encodeEvent (event) {
  // Fail fast on an unregistered/mistyped event.type here, at the one
  // actual entry point every caller goes through — without this,
  // preencode/encode's own `EVENT_TYPES[event.type] || 0` fallback would
  // silently write typeCode 0 with none of the type's real fields, and
  // decode would hand back only `{ type: undefined, timestamp }`, with
  // every other field permanently lost and no error anywhere to say why.
  if (!event || typeof event.type !== 'string' || !Object.prototype.hasOwnProperty.call(EVENT_TYPES, event.type)) {
    throw new Error(`Unknown event type: ${event && typeof event.type === 'string' ? JSON.stringify(event.type) : String(event && event.type)}`)
  }

  const state = { start: 0, end: 0, buffer: null }
  eventEncoding.preencode(state, event)
  state.buffer = b4a.allocUnsafe(state.end)
  eventEncoding.encode(state, event)
  return state.buffer
}

/**
 * Decode an event from a binary buffer.
 *
 * @param {Buffer} buffer - The binary buffer to decode
 * @returns {Object|null} The decoded event, or null if buffer is falsy
 */
function decodeEvent (buffer) {
  if (!buffer) return null
  const state = { start: 0, end: buffer.length, buffer }
  try {
    return eventEncoding.decode(state)
  } catch {
    // Malformed/truncated/adversarial bytes must never crash the caller —
    // this is wired directly into Autobase's apply loop (context-base.js
    // passes decodeEvent straight through as valueEncoding.decode) and
    // UserCore's read paths, none of which wrap this call in their own
    // try/catch. Returns the same safe shape already used for a structurally
    // valid but unrecognized event type, NOT null — null specifically means
    // "no buffer at all" to callers like GraphView's UserCore read loop
    // (view.js), which stops processing on a null event; a corrupted event
    // should be skipped, not mistaken for the end of the stream.
    return { type: undefined, timestamp: undefined, decodeError: true }
  }
}

/**
 * Event encoding exports.
 *
 * @module event-encoding
 * @property {Object} eventEncoding - The compact-encoding state machine for events
 * @property {Function} encodeEvent - Function to encode events to binary
 * @property {Function} decodeEvent - Function to decode events from binary
 * @property {Object} EVENT_TYPES - Mapping from event type strings to numeric codes
 * @property {Object} EVENT_TYPE_NAMES - Mapping from numeric codes to event type strings
 */
module.exports = {
  eventEncoding,
  encodeEvent,
  decodeEvent,
  EVENT_TYPES,
  EVENT_TYPE_NAMES
}
