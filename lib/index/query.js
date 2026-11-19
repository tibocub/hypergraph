// Reading the local index: fluent queries, what points at
// a record, counts and sums (one per member, the latest), live queries. Every
// read is bounded: it answers from what is held, waits up to its timeout for
// what is known but not held yet, and says whether the answer is complete.

const b4a = require('b4a')
const z32 = require('z32')
const enc = require('../encodings.js')
const gate = require('../gate.js')
const { isFuture, compare } = require('../stamp.js')
const { FLAGS, tagKey } = require('./indexer.js')
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
  if (types.has(row.type) && !(row.flags & FLAGS.UNREADABLE)) {
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
  if (row.flags & FLAGS.UNREADABLE) out.unreadable = true // written in the clear in a private space: no content
  if (row.flags & FLAGS.DROPPED) out.dropped = true // its content isn't here (space.since(): get() fetches it)
  if (isFuture(row.vstamp)) out.futureStamp = true
  return out
}

/**
 * A query on one type of records, from {@link Space#query}. Filters combine and return the query; end
 * with {@link Query#latest} or {@link Query#live}. Lists are newest first by when a record was put; paging
 * with `after` never skips or repeats one.
 */
class Query {
  constructor (space, type) {
    this.space = space
    this.type = type
    this.filter = null
    this.author = null
    this.device = null
    this.tagged = null
    this.target = null
    this.from = 0
    this.to = Infinity
    this.moderation = null
  }

  /**
   * Only records with this tag.
   * @param {string} name
   * @returns {Query}
   * @throws {TypeError} For an empty name.
   */
  tag (name) {
    if (typeof name !== 'string' || !name) throw new TypeError('A tag is a non-empty string')
    this.tagged = name
    return this
  }

  /**
   * Only records linking to a record (a link field: comments on a post).
   * @param {object|string} record A record or its id.
   * @returns {Query}
   */
  on (record) {
    this.target = idOf(record)
    return this
  }

  /**
   * Only records put at or after a time (inclusive).
   * @param {number} ms ms since 1970.
   * @returns {Query}
   */
  since (ms) {
    this.from = ms
    return this
  }

  /**
   * Only records put before a time.
   * @param {number} ms ms since 1970.
   * @returns {Query}
   */
  until (ms) {
    this.to = ms
    return this
  }

  /**
   * Only the records moderators hid, or flagged, however old. Hidden records are listed here and only here.
   * @param {string} state `'hidden'` or `'flagged'`.
   * @returns {Query}
   * @throws {TypeError} For any other state.
   */
  moderated (state) {
    if (state !== 'hidden' && state !== 'flagged') throw new TypeError('moderated() takes "hidden" or "flagged"')
    this.moderation = state
    return this
  }

  /**
   * Only records matching a declared index (the type's `index`); records with no value in those fields aren't in it.
   * @param {object} fields e.g. `{ forum: 'news' }`.
   * @returns {Query}
   */
  where (fields) {
    this.filter = fields
    return this
  }

  /**
   * Only records by one member.
   * @param {string} author Their identity key (z32).
   * @returns {Query}
   */
  by (author) {
    this.author = keyBytes(author, 'an identity')
    return this
  }

  /**
   * Only records one device put ("what does this device hold", in the personal space).
   * @param {string} device Its device key (z32).
   * @returns {Query}
   */
  fromDevice (device) {
    this.device = keyBytes(device, 'a device')
    return this
  }

  /**
   * The newest records, newest first.
   * @param {number} [n=20]
   * @param {object} [opts]
   * @param {object|null} [opts.after=null] The last record of the previous page.
   * @param {number} [opts.timeout] Wait up to this long (ms) while incomplete.
   * @returns {Promise<{items: object[], complete: boolean}>}
   */
  latest (n = 20, { after = null, timeout } = {}) {
    return this.space._bounded((deadline) => this.#run(n, after, deadline), timeout)
  }

  // One page, not bounded (getByTag merges several).
  _run (n, after, deadline) {
    return this.#run(n, after, deadline)
  }

  /**
   * Calls `fn` now, then again whenever its answer changed (records of this type changed, or it became
   * complete). Keeps the space open while running.
   * @param {function({items: object[], complete: boolean}): void} fn
   * @param {object} [opts]
   * @param {number} [opts.limit=20]
   * @returns {function(): void} `stop`.
   */
  live (fn, { limit = 20 } = {}) {
    return this.space._live(this.type, (deadline) => this.#run(limit, null, deadline), fn)
  }

  // `deadline`: until when content dropped here may be fetched; a
  // record it couldn't get is left out and the answer is partial.
  async #run (n, after, deadline = 0) {
    if (!this.space._types.has(this.type)) {
      if (this.space._typesPending()) return { items: [], partial: true } // its types haven't arrived
      this.space._types.get(this.type) // throws INVALID_TYPE
    }
    if (this.moderation) return this.#moderated(n, after, deadline)
    const { db, keyBytes: space, _types: types } = this.space
    // Every filter holds (AND); one picks the index, the others are checked on each row.
    let ix = null
    if (this.filter) {
      const names = Object.keys(this.filter)
      const declared = types.has(this.type) && types.get(this.type).index.some((f) => f.join(',') === names.join(','))
      if (!declared) throw new HypergraphError('INVALID_TYPE', `${this.type} declares no index on ${names.join(', ')}: add index: [[${names.map((x) => `'${x}'`).join(', ')}, 'stamp']]`)
      if (names.every((f) => this.filter[f] === null || this.filter[f] === undefined)) {
        throw new HypergraphError('INVALID_RECORD', `where() needs a value for ${names.join(' or ')}: records with no value there aren't in the index`)
      }
      ix = names.join(',') + '\0' + names.map((f) => String(this.filter[f] ?? '')).join('\0')
    }
    const tag = this.tagged ? tagKey(this.tagged) : null
    let index
    let prefix
    if (ix || tag) {
      index = '@hg/by-ix'
      prefix = { space, type: this.type, ix: ix || tag }
    } else if (this.target) {
      index = '@hg/by-link'
      prefix = { space, target: this.target, type: this.type }
    } else if (this.author) {
      index = '@hg/by-author'
      prefix = { space, author: this.author }
    } else {
      index = '@hg/by-type'
      prefix = { space, type: this.type }
    }
    const afterId = after ? idOf(after) : null
    const top = Math.min(after ? after.stamp : Infinity, this.to - 1)
    const range = { gte: this.from > 0 ? { ...prefix, stamp: this.from } : prefix, lte: top < Infinity ? { ...prefix, stamp: Math.max(0, top) } : prefix }
    const items = []
    let partial = false
    if (top < this.from) return { items, need: this.from }
    const typeOf = this.target ? this.space._typeOf() : null
    const stream = db.find(index, range, { reverse: true })
    for await (const row of stream) {
      if (row.type !== this.type || (row.flags & NOT_SHOWN)) continue
      if (!gate.mayPut(types, row, this.space.state)) continue
      if (row.stamp < this.from || row.stamp >= this.to) continue
      if (this.device && !b4a.equals(row.device, this.device)) continue
      if (this.author && !b4a.equals(row.author, this.author)) continue
      if (this.target && !(row.links || []).some((l) => b4a.equals(l, this.target))) continue
      if ((ix && !(row.ix || []).includes(ix)) || (tag && !(row.ix || []).includes(tag))) continue
      if (after && row.stamp === after.stamp && b4a.compare(row.id, afterId) >= 0) continue
      if (this.target) { // its link to the target must count
        const judged = await this.space._linkCounts(row, this.target, typeOf, deadline)
        if (judged.ok === null) partial = true
        if (!judged.ok) continue
        items.push(judged.row)
      } else {
        items.push(row)
      }
      if (items.length === n) break
    }
    await stream.destroy()
    const shaped = await this.space._shaped(items, deadline)
    // Complete when everything from the oldest item on is held (a full page),
    // or from `since` on (a member reading part of a big space).
    // This device's own records: complete once its own logs are indexed,
    // whoever else is offline.
    const mine = this.device && b4a.equals(this.device, this.space.hg._identity.device.publicKey)
    const need = mine ? 'own' : items.length === n ? Math.max(this.from, items[n - 1].stamp) : this.from
    return { items: shaped.items, partial: partial || shaped.partial, need }
  }

  // The moderated list: the ids the decisions name (a handful, whatever the
  // space's size), each row read, filtered and sorted newest first. The
  // decisions are held whole, so it is complete once the rows are.
  async #moderated (n, after, deadline) {
    const { db, keyBytes: space, _types: types, state } = this.space
    const flag = this.moderation === 'hidden' ? FLAGS.HIDDEN : FLAGS.FLAGGED
    const afterId = after ? idOf(after) : null
    const rows = []
    for (const [h, m] of state.moderated) {
      if (m.removed || !(this.moderation === 'hidden' ? m.hidden : m.flagged)) continue
      const row = await db.get('@hg/records', { space, id: b4a.from(h, 'hex') })
      if (!row || row.type !== this.type || !(row.flags & flag) || (row.flags & (FLAGS.REMOVED | FLAGS.SUPERSEDED))) continue
      if (!gate.mayPut(types, row, state)) continue
      if (row.stamp < this.from || row.stamp >= this.to) continue
      if (this.device && !b4a.equals(row.device, this.device)) continue
      if (this.author && !b4a.equals(row.author, this.author)) continue
      if (this.target && !(row.links || []).some((l) => b4a.equals(l, this.target))) continue
      if (this.filter || this.tagged) {
        const ix = this.filter ? Object.keys(this.filter).join(',') + ' ' + Object.keys(this.filter).map((f) => String(this.filter[f] ?? '')).join(' ') : null
        const tag = this.tagged ? tagKey(this.tagged) : null
        if ((ix && !(row.ix || []).includes(ix)) || (tag && !(row.ix || []).includes(tag))) continue
      }
      if (after && (row.stamp > after.stamp || (row.stamp === after.stamp && b4a.compare(row.id, afterId) >= 0))) continue
      rows.push(row)
    }
    rows.sort((a, b) => b.stamp - a.stamp || b4a.compare(b.id, a.id))
    const shaped = await this.space._shaped(rows.slice(0, n), deadline)
    return { items: shaped.items, partial: shaped.partial, need: 0 }
  }
}

// Records of any of the app's types with a tag, newest first (getByTag).
async function taggedRows (space, tag, n, after, deadline) {
  const names = space._types.names().filter((t) => !t.startsWith('hg/'))
  const lists = await Promise.all(names.map((t) => new Query(space, t).tag(tag)._run(n, after, deadline)))
  const all = lists.flatMap((l) => l.items)
  all.sort((a, b) => b.stamp - a.stamp || b4a.compare(idOf(b), idOf(a)))
  const items = all.slice(0, n)
  return { items, partial: lists.some((l) => l.partial), need: items.length === n ? items[n - 1].stamp : 0 }
}

// The edges of `record`: relations out of it, into
// it, or both. Per (from, to, type), the latest relate or unrelate by someone
// who may edit `from` (its author, or an editor of a shared type, cuts
// included) decides; an edge whose `from` isn't held doesn't show.
async function edgeRows (space, record, { direction = 'both', type = null } = {}) {
  const id = idOf(record)
  const prefix = { space: space.keyBytes, target: id, type: 'hg/relation' }
  const rows = await space.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()
  const best = new Map()
  const sources = new Map()
  for (const row of rows) {
    if (row.flags & NOT_SHOWN) continue
    let v = null
    try { v = space._types.decode('hg/relation', row.fields, row.links) } catch { continue }
    const from = enc.idBytes(v.from)
    const to = enc.idBytes(v.to)
    const out = b4a.equals(from, id)
    const inn = b4a.equals(to, id)
    if (!(direction === 'out' ? out : direction === 'in' ? inn : out || inn)) continue
    if (type && v.rel !== type) continue
    const fh = b4a.toString(from, 'hex')
    if (!sources.has(fh)) sources.set(fh, await space.db.get('@hg/records', { space: space.keyBytes, id: from }))
    const source = sources.get(fh)
    if (!source || !gate.mayEdit(space._types, { author: row.author, id: row.id }, source, space.state)) continue
    const key = `${v.from} ${v.to} ${v.rel}`
    const prev = best.get(key)
    if (!prev || compare(row, prev.row) > 0) best.set(key, { row, v })
  }
  return [...best.values()].filter(({ v }) => !v.off).sort((a, b) => compare(a.row, b.row)).map(({ row, v }) => ({
    id: enc.idToString(row.id),
    from: v.from,
    to: v.to,
    type: v.rel,
    value: v.value ?? null,
    data: v.data ?? null,
    author: z32.encode(row.author),
    stamp: row.stamp
  }))
}

// What points at `target` (optionally of one type), oldest first. Without a
// type, hypergraph's own records (relations, tags) are left out.
async function linkedRows (space, target, type) {
  const prefix = type ? { space: space.keyBytes, target: idOf(target), type } : { space: space.keyBytes, target: idOf(target) }
  const rows = await space.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()
  return rows.filter((row) => !(row.flags & NOT_SHOWN) && (type || !row.type.startsWith('hg/')) && gate.mayPut(space._types, row, space.state))
}

// The newest stamp among the tag records of `name` on a record (any author):
// an untag or tag again is stamped above it, so it wins.
async function tagStamp (space, id, name) {
  const prefix = { space: space.keyBytes, target: idOf(id), type: 'hg/tag' }
  let top = 0
  for (const row of await space.db.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()) {
    try { if (space._types.decode('hg/tag', row.fields, row.links).tag === name) top = Math.max(top, row.stamp) } catch {}
  }
  return top
}

module.exports = { Query, linkedRows, edgeRows, taggedRows, tagStamp, shape, keyBytes, idOf, NOT_SHOWN }
