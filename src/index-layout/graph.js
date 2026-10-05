const b4a = require('b4a')
const c = require('compact-encoding')
const IndexEncoder = require('index-encoder')
const { parseEntityId, formatEntityId } = require('./entity-id')

// GraphView keys and values, layout 2 (spec 002, data-model.md "Global view").
//
// Every key is an index-encoder tuple whose first byte is the index tag, so
// each index is one contiguous range and any leading part of a tuple is a
// valid range query. Values hold only what the key and the author's own log
// can't supply: a content version is a pointer (its seq in the author's log),
// not a copy of the body.

const { STRING, BUFFER, UINT } = IndexEncoder

const TAG = {
  FORMAT: 0x00,
  NODE: 0x01,
  NODE_BY_TYPE: 0x02,
  NODE_BY_TIME: 0x03,
  CONTENT: 0x04,
  PROFILE: 0x05,
  USER_PROGRESS: 0x06,
  CONTEXT_PROGRESS: 0x07
}

const FORMAT_VERSION = 2

const enc = {
  format: new IndexEncoder([], { prefix: TAG.FORMAT }),
  node: new IndexEncoder([STRING, BUFFER, UINT], { prefix: TAG.NODE }),
  nodeByType: new IndexEncoder([STRING, UINT, BUFFER, UINT], { prefix: TAG.NODE_BY_TYPE }),
  nodeByTime: new IndexEncoder([UINT, STRING, BUFFER, UINT], { prefix: TAG.NODE_BY_TIME }),
  content: new IndexEncoder([STRING, BUFFER, UINT, UINT], { prefix: TAG.CONTENT }),
  profile: new IndexEncoder([BUFFER], { prefix: TAG.PROFILE }),
  userProgress: new IndexEncoder([BUFFER], { prefix: TAG.USER_PROGRESS }),
  contextProgress: new IndexEncoder([BUFFER], { prefix: TAG.CONTEXT_PROGRESS })
}

const EMPTY = b4a.alloc(0)
const DELETED = 1
const HAS_BIO = 1

/**
 * A time as a key member: a non-negative safe integer. Event times are
 * claimed by their authors; anything else sorts as 0, like toSortableTs().
 */
function keyTime (ts) {
  const n = Number(ts)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0
}

const hexBytes = (hex) => b4a.from(hex, 'hex')

const nodeValue = {
  preencode (state, v) {
    c.uint.preencode(state, v.deleted ? DELETED : 0)
    c.uint.preencode(state, keyTime(v.createdAt))
    if (v.deleted) c.uint.preencode(state, keyTime(v.deletedAt))
  },
  encode (state, v) {
    c.uint.encode(state, v.deleted ? DELETED : 0)
    c.uint.encode(state, keyTime(v.createdAt))
    if (v.deleted) c.uint.encode(state, keyTime(v.deletedAt))
  },
  decode (state) {
    const flags = c.uint.decode(state)
    const createdAt = c.uint.decode(state)
    const deleted = (flags & DELETED) !== 0
    return { createdAt, deleted, deletedAt: deleted ? c.uint.decode(state) : null }
  }
}

const profileValue = {
  preencode (state, v) {
    c.uint.preencode(state, v.bio ? HAS_BIO : 0)
    c.uint.preencode(state, v.seq)
    c.string.preencode(state, v.username || '')
    if (v.bio) c.string.preencode(state, v.bio)
  },
  encode (state, v) {
    c.uint.encode(state, v.bio ? HAS_BIO : 0)
    c.uint.encode(state, v.seq)
    c.string.encode(state, v.username || '')
    if (v.bio) c.string.encode(state, v.bio)
  },
  decode (state) {
    const flags = c.uint.decode(state)
    const seq = c.uint.decode(state)
    const username = c.string.decode(state)
    const bio = (flags & HAS_BIO) ? c.string.decode(state) : null
    return { seq, username, bio }
  }
}

const prefixRange = (encoder, parts) => encoder.encodeRange({ gte: parts, lte: parts })

module.exports = {
  TAG,
  FORMAT_VERSION,
  keyTime,

  formatKey: () => enc.format.encode([]),
  encodeFormat: (version) => c.encode(c.uint, version),
  decodeFormat: (buf) => c.decode(c.uint, buf),

  // Node: (type, author, seq) → { createdAt, deleted, deletedAt }
  nodeKey: (p) => enc.node.encode([p.type, p.author, p.seq]),
  nodeRange: () => enc.node.encodeRange({}),
  nodeIdFromKey (key) {
    const [type, author, seq] = enc.node.decode(key)
    return formatEntityId({ type, author, seq })
  },
  encodeNode: (v) => c.encode(nodeValue, v),
  decodeNode: (buf) => c.decode(nodeValue, buf),

  // Node by type, then creation time: (type, createdAt, author, seq) → ∅
  nodeByTypeKey: (p, createdAt) => enc.nodeByType.encode([p.type, keyTime(createdAt), p.author, p.seq]),
  nodeByTypeRange: (type) => prefixRange(enc.nodeByType, [type]),
  nodeIdFromTypeKey (key) {
    const [type, , author, seq] = enc.nodeByType.decode(key)
    return formatEntityId({ type, author, seq })
  },

  // Node by creation time: (createdAt, type, author, seq) → ∅
  nodeByTimeKey: (p, createdAt) => enc.nodeByTime.encode([keyTime(createdAt), p.type, p.author, p.seq]),
  nodeByTimeRange: () => enc.nodeByTime.encodeRange({}),
  nodeIdFromTimeKey (key) {
    const [, type, author, seq] = enc.nodeByTime.decode(key)
    return formatEntityId({ type, author, seq })
  },

  // Content version: (type, author, seq, contentSeq) → ∅. The body is the
  // content/append event at contentSeq in the author's own log.
  contentKey: (p, contentSeq) => enc.content.encode([p.type, p.author, p.seq, contentSeq]),
  contentRange: (p) => prefixRange(enc.content, [p.type, p.author, p.seq]),
  contentSeqFromKey: (key) => enc.content.decode(key)[3],

  // Profile: author → { seq, username, bio }
  profileKey: (authorHex) => enc.profile.encode([hexBytes(authorHex)]),
  encodeProfile: (v) => c.encode(profileValue, v),
  decodeProfile: (buf) => c.decode(profileValue, buf),

  // Progress: how far each user log / context view has been indexed.
  userProgressKey: (coreKeyHex) => enc.userProgress.encode([hexBytes(coreKeyHex)]),
  contextProgressKey: (viewKeyHex) => enc.contextProgress.encode([hexBytes(viewKeyHex)]),
  encodeCount: (n) => c.encode(c.uint, n),
  decodeCount: (buf) => c.decode(c.uint, buf),

  parseEntityId,
  EMPTY
}
