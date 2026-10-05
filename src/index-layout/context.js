const b4a = require('b4a')
const c = require('compact-encoding')
const IndexEncoder = require('index-encoder')
const { toSortableTs, authorFromEntityId } = require('../utils')
const { toKeyParts, fromKeyParts } = require('./entity-id')

// A context view's bulky indexes — edges, incoming edges, active-edge refs,
// edge counters, tags — in one of two layouts (spec 002, data-model.md
// "Context view"). Both expose the same operations, so apply code and
// readers never build these keys themselves.
//
// Layout 1 is the text keys and JSON values every context used before.
// Layout 2 is binary: index-encoder tuples whose first byte is the index tag
// (0x10–0x16, below every text key, so both kinds live in one bee without
// meeting) and compact values holding only what the key can't.
//
// A context's layout is fixed by its `context/init` record, so every peer
// applying it builds byte-identical views (fast-forward shares them). The
// small, rare records (context record, roles, invites, moderation, writer
// links, messages) stay text in both layouts.

const { STRING, BUFFER, UINT } = IndexEncoder
const ID = [STRING, BUFFER, UINT] // an entity id: see entity-id.js

const BIN = { keyEncoding: 'binary', valueEncoding: 'binary' }

// ── Layout 1 ────────────────────────────────────────────────────────────────

const edgeKey1 = (from, type, createdAt, to) => `e:${from}:${type}:${toSortableTs(createdAt)}:${to}`
const inKey1 = (to, type, createdAt, from) => `i:in:${to}:${type}:${toSortableTs(createdAt)}:${from}`
const activeKey1 = (from, type, to) => `er:${from}:${type}:${to}`
const countKey1 = (direction, entityId, type) => `cnt:${direction}:${entityId}:${type}`
const tagKey1 = (tag, createdAt, entityId, author) => `t:${tag}:${toSortableTs(createdAt)}:${entityId}:${author}`
const tagRefKey1 = (tag, entityId, author) => `tref:${tag}:${entityId}:${author}`
const prefixRange1 = (prefix) => ({ gte: prefix, lt: prefix + '￿' })

const layout1 = {
  id: 1,

  async activeEdge (db, from, type, to) {
    const ref = await db.get(activeKey1(from, type, to))
    if (!ref || !ref.value || !ref.value.ref) return null
    const edge = await db.get(ref.value.ref)
    return edge && edge.value ? edge.value : null
  },

  async addEdge (db, e) {
    const key = edgeKey1(e.from, e.type, e.createdAt, e.to)
    await db.put(key, {
      from: e.from,
      to: e.to,
      type: e.type,
      author: e.author,
      createdAt: e.createdAt,
      deleted: false,
      value: typeof e.value === 'number' ? e.value : undefined,
      data: typeof e.data === 'string' ? e.data : undefined
    })
    await db.put(activeKey1(e.from, e.type, e.to), { ref: key })
    await db.put(inKey1(e.to, e.type, e.createdAt, e.from), { ref: key })
  },

  async removeEdge (db, from, type, createdAt, to) {
    const key = edgeKey1(from, type, createdAt, to)
    const existing = await db.get(key)
    if (existing) await db.put(key, { ...existing.value, deleted: true })
    await db.del(inKey1(to, type, createdAt, from))
    await db.del(activeKey1(from, type, to))
  },

  async getCount (db, direction, entityId, type) {
    const entry = await db.get(countKey1(direction, entityId, type))
    return entry && entry.value ? entry.value.count : 0
  },

  async putCount (db, direction, entityId, type, count) {
    await db.put(countKey1(direction, entityId, type), { count })
  },

  async addTag (db, t) {
    const key = tagKey1(t.tag, t.createdAt, t.entityId, t.author)
    await db.put(key, { entityId: t.entityId, tag: t.tag, author: t.author, createdAt: t.createdAt })
    await db.put(tagRefKey1(t.tag, t.entityId, t.author), { ref: key })
  },

  async removeTag (db, tag, entityId, author) {
    const refKey = tagRefKey1(tag, entityId, author)
    const ref = await db.get(refKey)
    if (ref) await db.del(ref.value.ref)
    await db.del(refKey)
  },

  // Stored edge records, deleted ones included; `limit` bounds index entries read.
  async * edges (db, entityId, opts = {}) {
    const inbound = opts.direction === 'in'
    const base = inbound ? `i:in:${entityId}:` : `e:${entityId}:`
    const prefix = opts.type ? `${base}${opts.type}:` : base
    const stream = db.createReadStream({ ...prefixRange1(prefix), reverse: !!opts.reverse, limit: opts.limit || undefined })
    for await (const entry of stream) {
      if (!inbound) {
        yield entry.value
        continue
      }
      const edge = await db.get(entry.value.ref)
      if (edge && edge.value) yield edge.value
    }
  },

  async * tagged (db, tag, opts = {}) {
    const prefix = tag == null ? 't:' : `t:${tag}:`
    for await (const entry of db.createReadStream({ ...prefixRange1(prefix), limit: opts.limit || undefined })) {
      if (!entry.key.startsWith(prefix)) continue
      yield entry.value
    }
  },

  async hasTag (db, entityId, tag) {
    const prefix = `tref:${tag}:${entityId}:`
    for await (const entry of db.createReadStream({ ...prefixRange1(prefix), limit: 1 })) {
      if (entry && entry.key && entry.key.startsWith(prefix)) return true
    }
    return false
  }
}

// ── Layout 2 ────────────────────────────────────────────────────────────────

const TAG = {
  EDGE: 0x10,
  IN_EDGE: 0x11,
  ACTIVE_EDGE: 0x12,
  COUNT_IN: 0x13,
  COUNT_OUT: 0x14,
  TAG: 0x15,
  TAG_REF: 0x16
}

// A tag author is a key in hex. As (32 bytes, '') when it is one, else
// (<empty>, the string as given), so any string round-trips exactly.
const HEX64 = /^[0-9a-f]{64}$/
const EMPTY = b4a.alloc(0)
const authorParts = (a) => HEX64.test(a) ? [b4a.from(a, 'hex'), ''] : [EMPTY, String(a)]
const authorFromParts = (key, raw) => key && key.length ? b4a.toString(key, 'hex') : raw

const enc = {
  edge: new IndexEncoder([...ID, STRING, UINT, ...ID], { prefix: TAG.EDGE }),
  inEdge: new IndexEncoder([...ID, STRING, UINT, ...ID], { prefix: TAG.IN_EDGE }),
  activeEdge: new IndexEncoder([...ID, STRING, ...ID], { prefix: TAG.ACTIVE_EDGE }),
  countIn: new IndexEncoder([...ID, STRING], { prefix: TAG.COUNT_IN }),
  countOut: new IndexEncoder([...ID, STRING], { prefix: TAG.COUNT_OUT }),
  tag: new IndexEncoder([STRING, UINT, ...ID, BUFFER, STRING], { prefix: TAG.TAG }),
  tagRef: new IndexEncoder([STRING, ...ID, BUFFER, STRING], { prefix: TAG.TAG_REF })
}

const keyTime = (ts) => {
  const n = Number(ts)
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER) : 0
}

const edgeKey2 = (from, type, createdAt, to) => enc.edge.encode([...toKeyParts(from), type, keyTime(createdAt), ...toKeyParts(to)])
const prefixRange2 = (encoder, parts) => encoder.encodeRange({ gte: parts, lte: parts })

const DELETED = 1
const HAS_VALUE = 2
const HAS_DATA = 4

// Edge value: what the key can't supply. The author is `from`'s author:
// apply rejects any relation whose signer isn't, so it is never different.
const edgeValue = {
  preencode (state, v) {
    c.uint.preencode(state, edgeFlags(v))
    if (typeof v.value === 'number') c.float64.preencode(state, v.value)
    if (typeof v.data === 'string') c.string.preencode(state, v.data)
  },
  encode (state, v) {
    c.uint.encode(state, edgeFlags(v))
    if (typeof v.value === 'number') c.float64.encode(state, v.value)
    if (typeof v.data === 'string') c.string.encode(state, v.data)
  },
  decode (state) {
    const flags = c.uint.decode(state)
    const out = { deleted: (flags & DELETED) !== 0 }
    if (flags & HAS_VALUE) out.value = c.float64.decode(state)
    if (flags & HAS_DATA) out.data = c.string.decode(state)
    return out
  }
}

function edgeFlags (v) {
  return (v.deleted ? DELETED : 0) | (typeof v.value === 'number' ? HAS_VALUE : 0) | (typeof v.data === 'string' ? HAS_DATA : 0)
}

// The same record shape layout 1 stores (absent value/data are left out,
// as JSON leaves out undefined).
function edgeRecord (from, type, createdAt, to, valueBuf) {
  const v = c.decode(edgeValue, valueBuf)
  const rec = { from, to, type, author: authorFromEntityId(from), createdAt, deleted: v.deleted }
  if ('value' in v) rec.value = v.value
  if ('data' in v) rec.data = v.data
  return rec
}

function decodeEdgeKey (key) {
  const m = enc.edge.decode(key)
  return { from: fromKeyParts(m.slice(0, 3)), type: m[3], createdAt: m[4], to: fromKeyParts(m.slice(5, 8)) }
}

const countEncoder = (direction) => direction === 'in' ? enc.countIn : enc.countOut

const layout2 = {
  id: 2,

  async activeEdge (db, from, type, to) {
    const ref = await db.get(enc.activeEdge.encode([...toKeyParts(from), type, ...toKeyParts(to)]), BIN)
    if (!ref) return null
    const createdAt = c.decode(c.uint, ref.value)
    const edge = await db.get(edgeKey2(from, type, createdAt, to), BIN)
    return edge ? edgeRecord(from, type, createdAt, to, edge.value) : null
  },

  async addEdge (db, e) {
    const createdAt = keyTime(e.createdAt)
    await db.put(edgeKey2(e.from, e.type, createdAt, e.to), c.encode(edgeValue, { deleted: false, value: e.value, data: e.data }), BIN)
    await db.put(enc.activeEdge.encode([...toKeyParts(e.from), e.type, ...toKeyParts(e.to)]), c.encode(c.uint, createdAt), BIN)
    await db.put(enc.inEdge.encode([...toKeyParts(e.to), e.type, createdAt, ...toKeyParts(e.from)]), EMPTY, BIN)
  },

  async removeEdge (db, from, type, createdAt, to) {
    const key = edgeKey2(from, type, createdAt, to)
    const existing = await db.get(key, BIN)
    if (existing) {
      const v = c.decode(edgeValue, existing.value)
      await db.put(key, c.encode(edgeValue, { ...v, deleted: true }), BIN)
    }
    await db.del(enc.inEdge.encode([...toKeyParts(to), type, keyTime(createdAt), ...toKeyParts(from)]), BIN)
    await db.del(enc.activeEdge.encode([...toKeyParts(from), type, ...toKeyParts(to)]), BIN)
  },

  async getCount (db, direction, entityId, type) {
    const entry = await db.get(countEncoder(direction).encode([...toKeyParts(entityId), type]), BIN)
    return entry ? c.decode(c.uint, entry.value) : 0
  },

  async putCount (db, direction, entityId, type, count) {
    await db.put(countEncoder(direction).encode([...toKeyParts(entityId), type]), c.encode(c.uint, count), BIN)
  },

  async addTag (db, t) {
    const createdAt = keyTime(t.createdAt)
    const author = authorParts(t.author)
    await db.put(enc.tag.encode([t.tag, createdAt, ...toKeyParts(t.entityId), ...author]), EMPTY, BIN)
    await db.put(enc.tagRef.encode([t.tag, ...toKeyParts(t.entityId), ...author]), c.encode(c.uint, createdAt), BIN)
  },

  async removeTag (db, tag, entityId, author) {
    const parts = authorParts(author)
    const refKey = enc.tagRef.encode([tag, ...toKeyParts(entityId), ...parts])
    const ref = await db.get(refKey, BIN)
    if (ref) await db.del(enc.tag.encode([tag, c.decode(c.uint, ref.value), ...toKeyParts(entityId), ...parts]), BIN)
    await db.del(refKey, BIN)
  },

  async * edges (db, entityId, opts = {}) {
    const inbound = opts.direction === 'in'
    const encoder = inbound ? enc.inEdge : enc.edge
    const parts = opts.type ? [...toKeyParts(entityId), opts.type] : toKeyParts(entityId)
    const stream = db.createReadStream({ ...prefixRange2(encoder, parts), reverse: !!opts.reverse, limit: opts.limit || undefined }, BIN)
    for await (const entry of stream) {
      if (!inbound) {
        const k = decodeEdgeKey(entry.key)
        yield edgeRecord(k.from, k.type, k.createdAt, k.to, entry.value)
        continue
      }
      // The incoming entry's members are the edge key's, reordered.
      const m = enc.inEdge.decode(entry.key)
      const to = fromKeyParts(m.slice(0, 3))
      const type = m[3]
      const createdAt = m[4]
      const from = fromKeyParts(m.slice(5, 8))
      const edge = await db.get(edgeKey2(from, type, createdAt, to), BIN)
      if (edge) yield edgeRecord(from, type, createdAt, to, edge.value)
    }
  },

  async * tagged (db, tag, opts = {}) {
    const range = tag == null ? enc.tag.encodeRange({}) : prefixRange2(enc.tag, [tag])
    for await (const entry of db.createReadStream({ ...range, limit: opts.limit || undefined }, BIN)) {
      const m = enc.tag.decode(entry.key)
      yield { entityId: fromKeyParts(m.slice(2, 5)), tag: m[0], author: authorFromParts(m[5], m[6]), createdAt: m[1] }
    }
  },

  async hasTag (db, entityId, tag) {
    for await (const entry of db.createReadStream({ ...prefixRange2(enc.tagRef, [tag, ...toKeyParts(entityId)]), limit: 1 }, BIN)) {
      if (entry) return true
    }
    return false
  }
}

const LAYOUTS = { 1: layout1, 2: layout2 }
const KNOWN_LAYOUTS = [1, 2]
const NEW_CONTEXT_LAYOUT = 2

/** The layout a context record names; contexts from before layouts are 1. */
function layoutFor (record) {
  return LAYOUTS[(record && record.layout) || 1] || null
}

module.exports = { layout1, layout2, layoutFor, KNOWN_LAYOUTS, NEW_CONTEXT_LAYOUT, TAG }
