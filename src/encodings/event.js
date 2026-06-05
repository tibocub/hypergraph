const c = require('compact-encoding')
const b4a = require('b4a')

// Event type constants - map from string to code
const EVENT_TYPES = {
  'entity/create': 1,
  'entity/tombstone': 2,
  'content/append': 3,
  'relation/create': 4,
  'relation/delete': 5,
  'tag/add': 6,
  'tag/remove': 7,
  'identity/update': 8
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
  8: 'identity/update'
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
      case 'relation/delete':
        c.string.preencode(state, event.from)
        c.string.preencode(state, event.to)
        c.string.preencode(state, event.relationType)
        c.string.preencode(state, event.author)
        break

      case 'tag/add':
      case 'tag/remove':
        c.string.preencode(state, event.entityId)
        c.string.preencode(state, event.tag)
        c.string.preencode(state, event.author)
        break

      case 'identity/update':
        c.string.preencode(state, event.author)
        c.string.preencode(state, event.username)
        c.string.preencode(state, event.bio || '')
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
      case 'relation/delete':
        c.string.encode(state, event.from)
        c.string.encode(state, event.to)
        c.string.encode(state, event.relationType)
        c.string.encode(state, event.author)
        break

      case 'tag/add':
      case 'tag/remove':
        c.string.encode(state, event.entityId)
        c.string.encode(state, event.tag)
        c.string.encode(state, event.author)
        break

      case 'identity/update':
        c.string.encode(state, event.author)
        c.string.encode(state, event.username)
        c.string.encode(state, event.bio || '')
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
      case 'relation/delete':
        event.from = c.string.decode(state)
        event.to = c.string.decode(state)
        event.relationType = c.string.decode(state)
        event.author = c.string.decode(state)
        break

      case 'tag/add':
      case 'tag/remove':
        event.entityId = c.string.decode(state)
        event.tag = c.string.decode(state)
        event.author = c.string.decode(state)
        break

      case 'identity/update':
        event.author = c.string.decode(state)
        event.username = c.string.decode(state)
        event.bio = c.string.decode(state) || null
        break
    }

    return event
  }
}

function encodeEvent (event) {
  const state = { start: 0, end: 0, buffer: null }
  eventEncoding.preencode(state, event)
  state.buffer = b4a.allocUnsafe(state.end)
  eventEncoding.encode(state, event)
  return state.buffer
}

function decodeEvent (buffer) {
  if (!buffer) return null
  const state = { start: 0, end: buffer.length, buffer }
  return eventEncoding.decode(state)
}

module.exports = {
  eventEncoding,
  encodeEvent,
  decodeEvent,
  EVENT_TYPES,
  EVENT_TYPE_NAMES
}
