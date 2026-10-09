// Reading the local index (research R12, R13): fluent queries, what points at
// a record, counts and sums (one per member, the latest), live queries. Every
// read is bounded: it answers from what is held, waits up to its timeout for
// what is known but not held yet, and says whether the answer is complete.

const b4a = require('b4a')
const z32 = require('z32')
const enc = require('../encodings.js')
const { isFuture } = require('../stamp.js')
const { FLAGS } = require('./indexer.js')
const { HypergraphError } = require('../errors.js')

const NOT_SHOWN = FLAGS.HIDDEN | FLAGS.REMOVED | FLAGS.SUPERSEDED

const keyBytes = (k, what) => {
  try {
    const b = typeof k === 'string' ? z32.decode(k) : (k && k.publicKey ? keyBytes(k.publicKey, what) : k)
    if (b4a.isBuffer(b) && b.byteLength === 32) return b
  } catch {}
  throw new HypergraphError('NOT_FOUND', `Not ${what}: ${k}`)
}

const idOf = (r) => enc.idBytes(typeof r === 'string' || b4a.isBuffer(r) ? r : r.id)

// A row as the app sees it: the record's current version.
function shape (types, row) {
  let values = {}
  if (types.has(row.type)) {
    try { values = types.decode(row.type, row.fields || b4a.alloc(0), row.links || []) } catch {}
  }
  const out = {
    ...values,
    id: enc.idToString(row.id),
    type: row.type,
    author: z32.encode(row.author),
    device: z32.encode(row.vdevice),
    stamp: row.stamp,
    edited: !!(row.flags & FLAGS.EDITED)
  }
  if (row.flags & FLAGS.HIDDEN) out.hidden = true // by a moderator: left out of lists, found by get()
  if (row.flags & FLAGS.FLAGGED) out.flagged = true
  if (isFuture(row.vstamp)) out.futureStamp = true
  return out
}

class Query {
  constructor (space, type) {
    this.space = space
    this.type = type
    this.filter = null
    this.author = null
    this.device = null
  }

  // Records whose app-declared index matches, e.g. where({ forum: 'news' }).
  where (fields) {
    this.filter = fields
    return this
  }

  // Records by one member (their identity key).
  by (author) {
    this.author = keyBytes(author, 'an identity')
    return this
  }

  // Records one device put (its device key): what that device wrote, e.g.
  // "what does this device hold" in the personal space.
  fromDevice (device) {
    this.device = keyBytes(device, 'a device')
    return this
  }

  // The newest n, newest first. { after: a record from the last page } pages.
  latest (n = 20, { after = null, timeout } = {}) {
    return this.space._bounded(() => this.#run(n, after), timeout)
  }

  // Calls fn({ items, complete }) now and whenever records of this type
  // change; returns stop().
  live (fn, { limit = 20 } = {}) {
    return this.space._live(this.type, () => this.#run(limit, null), fn)
  }

  async #run (n, after) {
    const { db, keyBytes: space, types } = this.space
    let index
    let prefix
    if (this.filter) {
      const names = Object.keys(this.filter)
      const declared = types.has(this.type) && types.get(this.type).index.some((f) => f.join(',') === names.join(','))
      if (!declared) throw new HypergraphError('INVALID_TYPE', `${this.type} declares no index on ${names.join(', ')}: add index: [[${names.map((x) => `'${x}'`).join(', ')}, 'stamp']]`)
      index = '@hg/by-ix'
      prefix = { space, type: this.type, ix: names.join(',') + '\0' + names.map((f) => String(this.filter[f] ?? '')).join('\0') }
    } else if (this.author) {
      index = '@hg/by-author'
      prefix = { space, author: this.author }
    } else {
      index = '@hg/by-type'
      prefix = { space, type: this.type }
    }
    const afterId = after ? idOf(after) : null
    const range = after ? { gte: prefix, lte: { ...prefix, stamp: after.stamp } } : { gte: prefix, lte: prefix }
    const items = []
    const stream = db.find(index, range, { reverse: true })
    for await (const row of stream) {
      if (row.type !== this.type || (row.flags & NOT_SHOWN)) continue
      if (this.device && !b4a.equals(row.device, this.device)) continue
      if (after && row.stamp === after.stamp && b4a.compare(row.id, afterId) >= 0) continue
      items.push(shape(types, row))
      if (items.length === n) break
    }
    await stream.destroy()
    return { items }
  }
}

// What points at `target` (optionally of one type), oldest first.
async function linkedRows (space, target, type) {
  const prefix = type ? { space: space.keyBytes, target: idOf(target), type } : { space: space.keyBytes, target: idOf(target) }
  const rows = await space.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()
  return rows.filter((row) => !(row.flags & NOT_SHOWN))
}

module.exports = { Query, linkedRows, shape, keyBytes, idOf }
