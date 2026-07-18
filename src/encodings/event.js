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
  'roles/removeWriter': 13
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
  13: 'roles/removeWriter'
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
        break

      case 'relation/create':
        c.string.preencode(state, event.from)
        c.string.preencode(state, event.to)
        c.string.preencode(state, event.relationType)
        c.string.preencode(state, event.author)
        c.buffer.preencode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
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
        break

      case 'relation/create':
        c.string.encode(state, event.from)
        c.string.encode(state, event.to)
        c.string.encode(state, event.relationType)
        c.string.encode(state, event.author)
        c.buffer.encode(state, event.signature ? b4a.from(event.signature, 'hex') : b4a.alloc(0))
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
        break

      case 'relation/create':
        event.from = c.string.decode(state)
        event.to = c.string.decode(state)
        event.relationType = c.string.decode(state)
        event.author = c.string.decode(state)
        const sig1 = c.buffer.decode(state)
        event.signature = sig1.length > 0 ? sig1.toString('hex') : null
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
  return eventEncoding.decode(state)
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
