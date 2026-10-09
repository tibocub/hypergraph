// The local index's writer (research R12): logs → gate → rows.
//
// A put becomes a row in `records`. An edit or delete is kept in `changes` by
// its target, because it can arrive before the target (another log, slower);
// whenever either side arrives, the target's current version is the latest
// allowed change (latest wins: lib/stamp.js), and an allowed delete removes
// the row for good and clears the record's blocks. One-per-member types keep
// every row; all but each member's latest are flagged SUPERSEDED, so the
// order of arrival never matters.

const b4a = require('b4a')
const z32 = require('z32')
const safetyCatch = require('safety-catch')
const enc = require('../encodings.js')
const gate = require('../gate.js')
const { compare } = require('../stamp.js')

const FLAGS = { HIDDEN: 1, REMOVED: 2, SUPERSEDED: 4, EDITED: 8, FLAGGED: 16 }
const BATCH = 64 // blocks per transaction
const EMPTY = b4a.alloc(0)

// One write queue per instance: every change to the index runs alone, in a
// transaction committed at its end (the spike: HyperDB refuses to commit
// during another insert). A task that throws commits nothing.
class WriteQueue {
  constructor (db) {
    this.db = db
    this.tail = Promise.resolve()
  }

  run (fn) {
    const task = this.tail.then(async () => {
      const tx = this.db.transaction()
      try {
        const result = await fn(tx)
        await tx.flush()
        return result
      } catch (err) {
        await tx.close()
        throw err
      }
    })
    this.tail = task.catch(() => {})
    return task
  }

  // Resolves when everything queued so far is committed.
  idle () {
    return this.tail
  }
}

// App-declared index keys of a record: "forum\0news" per declared index.
function ixKeys (types, type, values) {
  if (!values || !types.has(type)) return []
  return types.get(type).index.map((fields) => fields.join(',') + '\0' + fields.map((f) => String(values[f] ?? '')).join('\0'))
}

// The index key of a tag on a record (research.md A9): with the app's keys,
// so tagged lists page by when the record was put, like any query.
const tagKey = (tag) => '\0#' + tag
const byKey = (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)

// Indexes one space's logs. `space` gives: key, types, state (decisions),
// me (identity), stamper, changed(types), clear(id).
class Indexer {
  constructor (space, queue) {
    this.space = space
    this.queue = queue
    this.applied = new Map() // record id hex -> moderation applied to its row
    this.timers = new Set()
    this.closed = false
  }

  // Indexes what `log` holds that wasn't looked at yet. A block not held
  // doesn't stop the blocks after it (it's a hole, indexed when it arrives),
  // and a hole known to be wiped (its author deleted it) is done. One run per
  // log at a time; a call during a run makes it go round again.
  index (log) {
    if (this.closed) return Promise.resolve()
    if (log.indexing) {
      log.again = true
      return log.indexing
    }
    log.indexing = this.#run(log).catch((err) => { safetyCatch(err) }).finally(() => {
      log.indexing = null
      this.#recheckHoles(log)
    })
    return log.indexing
  }

  // Holes are looked at again after a short wait, growing to 5 s while none
  // fills: a block's arrival can be missed (it raced the scan, or a clear of
  // the block next to it), and a missed hole would stay "missing" for good.
  #recheckHoles (log) {
    if (!log.holes.size) {
      log.holeWait = 0
      return
    }
    if (log.holeTimer || this.closed) return
    log.holeWait = Math.min((log.holeWait || 50) * 2, 5000)
    const timer = log.holeTimer = setTimeout(() => {
      this.timers.delete(timer)
      log.holeTimer = null
      for (const seq of log.holes) log.arrived.add(seq)
      this.index(log)
    }, log.holeWait)
    this.timers.add(timer)
    if (timer.unref) timer.unref()
  }

  // A block arrived. Below `scanned` it may be a hole, or about to become one
  // (the scan is looking at it): the run checks.
  arrived (log, seq) {
    if (seq < log.scanned) log.arrived.add(seq)
  }

  // Record `id` was deleted by its author (or taken down: author null): if its
  // block is a hole, it's done.
  wiped (id, author) {
    const { log: key, seq } = enc.idParts(id)
    const log = this.space.logOf(key)
    if (!log || (author && !b4a.equals(log.identity, author)) || !log.holes.has(seq)) return
    log.holes.delete(seq)
    this.index(log).catch(safetyCatch)
  }

  // The decisions changed: moderation (hide, reveal, flag, take down) reaches
  // the rows it applies to. Rows indexed later get it when inserted.
  async moderate () {
    const todo = []
    for (const [h, m] of this.space.state.moderated) {
      const sig = modFlags(0, m) | (m.removed ? FLAGS.REMOVED : 0)
      if (this.applied.get(h) !== sig) todo.push([h, m, sig])
    }
    if (!todo.length || this.closed) return
    const changed = new Set()
    const clears = []
    await this.queue.run(async (tx) => {
      for (const [h, m] of todo) {
        const id = b4a.from(h, 'hex')
        const row = await tx.get('@hg/records', { space: this.space.key, id })
        if (m.removed) {
          clears.push(id)
          if (row) await this.#takeDown(tx, row, changed, clears)
          continue
        }
        if (!row) continue
        const flags = modFlags(row.flags, m)
        if (flags === row.flags) continue
        row.flags = flags
        await tx.insert('@hg/records', row)
        changed.add(row.type)
        if (row.type === 'hg/tag') await this.#retagged(tx, row, changed)
      }
    })
    for (const [h, m, sig] of todo) {
      this.applied.set(h, sig)
      if (m.removed) this.wiped(b4a.from(h, 'hex'), null)
    }
    for (const id of clears) await this.space.clear(id)
    this.space.changed(changed)
  }

  // A record taken down by moderation: gone, with its edits' blocks.
  async #takeDown (tx, row, changed, clears) {
    await tx.delete('@hg/records', { space: row.space, id: row.id })
    changed.add(row.type)
    if (row.opm) await this.#regroup(tx, row)
    if (row.type === 'hg/tag') await this.#retagged(tx, row, changed)
    const all = await tx.find('@hg/changes', { gte: { space: row.space, target: row.id }, lte: { space: row.space, target: row.id } }).toArray()
    for (const ch of all) clears.push(ch.id)
  }

  // The record as the app's rules see it: its fields and who wrote it.
  #brokenRule (type, values, id, log, stamp) {
    if (!values || !this.space.rules.length || !this.space.types.has(type) || type.startsWith('hg/')) return null
    const record = { ...values, id: enc.idToString(id), type, author: z32.encode(log.identity), device: z32.encode(log.device), stamp }
    return gate.brokenRule(this.space.rules, record, { space: z32.encode(this.space.key) })
  }

  async #run (log) {
    do {
      log.again = false
      for (;;) {
        if (this.closed) return
        const batch = []
        for (const seq of log.arrived) {
          if (batch.length >= BATCH) break
          log.arrived.delete(seq)
          const bytes = log.holes.has(seq) ? await log.core.get(seq, { wait: false }) : null
          if (bytes) batch.push([seq, bytes])
        }
        const end = Math.min(log.core.length, log.limit)
        while (batch.length < BATCH && log.scanned < end) {
          const seq = log.scanned++
          const bytes = await log.core.get(seq, { wait: false })
          if (bytes) batch.push([seq, bytes])
          else if (!(await this.#wipedByAuthor(log, seq))) log.holes.add(seq)
        }
        for (const [s] of batch) log.holes.delete(s)
        const indexed = log.holes.size ? Math.min(...log.holes) : log.scanned
        if (!batch.length && indexed === log.indexed) break
        const changed = new Set()
        const clears = []
        const wiped = []
        const removals = []
        await this.queue.run(async (tx) => {
          for (const [s, bytes] of batch) if (s > 0) await this.#one(tx, log, s, bytes, changed, clears, wiped, removals)
          await tx.insert('@hg/logs', logRow(this.space, log, indexed))
        })
        log.indexed = indexed
        for (const id of clears) await this.space.clear(id)
        for (const [id, author] of wiped) this.wiped(id, author)
        for (const [values, identity] of removals) this.space.removed(values, identity)
        this.space.changed(changed)
      }
    } while (log.again)
  }

  // Is the missing block `seq` of `log` one its author deleted, or one taken
  // down by moderation?
  async #wipedByAuthor (log, seq) {
    if (seq === 0) return false
    const target = enc.idBytes({ log: log.key, seq })
    if (this.space.state.isRemoved(target)) return true
    const changes = await this.queue.db.find('@hg/changes', { gte: { space: this.space.key, target }, lte: { space: this.space.key, target } }).toArray()
    return changes.some((ch) => ch.kind === enc.DELETE && b4a.equals(ch.author, log.identity))
  }

  // `log` lost the right to write: what is past `limit` no longer counts.
  // Its rows and changes go (an edit undone brings back the version before,
  // a vote undone the member's earlier vote), its blocks are cleared.
  async cut (log, limit) {
    log.limit = limit
    const upto = Math.max(log.scanned, log.indexed)
    for (const s of log.holes) if (s >= limit) log.holes.delete(s)
    if (log.scanned > limit) log.scanned = limit
    const changed = new Set()
    const clears = []
    await this.queue.run(async (tx) => {
      for (let seq = Math.max(limit, 1); seq < upto; seq++) await this.#uncount(tx, log, seq, changed, clears)
      log.indexed = log.holes.size ? Math.min(...log.holes) : log.scanned
      log.cut = limit
      await tx.insert('@hg/logs', logRow(this.space, log, log.indexed))
    })
    for (const id of clears) await this.space.clear(id)
    this.space.changed(changed)
  }

  // Undoes whatever block `seq` of `log` did to the index.
  async #uncount (tx, log, seq, changed, clears) {
    const space = this.space.key
    const id = enc.idBytes({ log: log.key, seq })
    const row = await tx.get('@hg/records', { space, id })
    if (row) {
      await tx.delete('@hg/records', { space, id })
      changed.add(row.type)
      if (row.opm) await this.#regroup(tx, row)
      if (row.type === 'hg/tag') await this.#retagged(tx, row, changed)
      return
    }
    const change = await tx.findOne('@hg/changes-by-id', { gte: { space, id }, lte: { space, id } })
    if (!change) return
    await tx.delete('@hg/changes', { space, target: change.target, id })
    const target = await tx.get('@hg/records', { space, id: change.target })
    if (!target) return // a delete that already wiped it: nothing to bring back
    await this.#resettle(tx, target, clears)
    changed.add(target.type)
  }

  // Recomputes a record's current version from its put and the changes left.
  async #resettle (tx, row, clears) {
    const log = this.space.logOf(row.log)
    const bytes = log ? await log.core.get(row.seq, { wait: false }) : null
    if (bytes) {
      const put = enc.decodeRecord(bytes)
      let values = null
      try { values = this.space.types.has(row.type) ? this.space.types.decode(row.type, put.fields, put.links) : null } catch {}
      row.vstamp = put.stamp
      row.vdevice = row.device
      row.fields = put.fields
      row.links = put.links
      row.ix = await this.#ix(tx, row, values)
      row.flags &= ~FLAGS.EDITED
    }
    const changes = await tx.find('@hg/changes', { gte: { space: row.space, target: row.id }, lte: { space: row.space, target: row.id } }).toArray()
    if (await this.#settle(tx, row, changes, clears, true)) await tx.delete('@hg/records', { space: row.space, id: row.id })
    else await tx.insert('@hg/records', row)
  }

  async #one (tx, log, seq, bytes, changed, clears, wiped, removals) {
    if (seq >= log.limit) return // cut while this batch waited
    const { types, key: space } = this.space
    const res = gate.checkRecord(bytes, types)
    if (!res.ok) return
    const { record, values } = res
    if (b4a.equals(log.identity, this.space.me)) this.space.stamper.seen(record.stamp)
    // Hypergraph's own types only where they belong; removals signed by the
    // identity key (lib/space.js, research.md A7).
    if (!this.space.allowed(log, record, values) || !gate.builtinValid(record, values)) return
    if (record.type === 'hg/device-remove') removals.push([values, log.identity])
    const id = enc.idBytes({ log: log.key, seq })

    if (record.kind !== enc.PUT) {
      // An edit of a record taken down, or breaking the app's rules: not kept
      // (by others: a member's own records are never dropped, FR-027).
      if (this.space.state.isRemoved(record.target)) {
        clears.push(id)
        return
      }
      if (record.kind === enc.EDIT && this.#brokenRule(record.type, values, record.target, log, record.stamp)) {
        if (!log.own) clears.push(id)
        return
      }
      const change = { space, target: record.target, id, kind: record.kind, type: record.type, author: log.identity, device: log.device, stamp: record.stamp, fields: record.fields, links: record.links }
      await tx.insert('@hg/changes', change)
      const row = await tx.get('@hg/records', { space, id: record.target })
      if (row && await this.#settle(tx, row, [change], clears)) changed.add(row.type)
      if (!row && record.kind === enc.DELETE) wiped.push([record.target, log.identity])
      return
    }

    if (await tx.get('@hg/records', { space, id })) return // indexed before (holes are looked at again after a restart)

    const typeOf = async (target) => {
      const t = await tx.get('@hg/records', { space, id: enc.idBytes(target) })
      return t ? t.type : null
    }
    if (!(await gate.linksAllowed(types, record.type, values, typeOf))) return
    // Records taken down, or breaking the app's rules, are neither indexed
    // nor kept (a member's own are never dropped, FR-027: others fetch them
    // from it, check them and drop them, so they leave no hole for anyone).
    if (this.space.state.isRemoved(id)) {
      clears.push(id)
      return
    }
    if (this.#brokenRule(record.type, values, id, log, record.stamp)) {
      if (!log.own) clears.push(id)
      return
    }

    const decl = types.has(record.type) ? types.get(record.type) : null
    const opm = !!(decl && decl.onePerMember)
    const row = {
      space,
      id,
      type: record.type,
      author: log.identity,
      device: log.device,
      log: log.key,
      seq,
      stamp: record.stamp,
      vstamp: record.stamp,
      vdevice: log.device,
      fields: record.fields,
      links: record.links,
      ix: ixKeys(types, record.type, values),
      flags: modFlags(0, this.space.state.moderation(id)),
      opm,
      target: opm ? (decl.target && values[decl.target] ? enc.idBytes(values[decl.target]) : EMPTY) : null
    }
    row.ix = row.ix.concat(await this.#tagKeys(tx, row))

    const pending = await tx.find('@hg/changes', { gte: { space, target: id }, lte: { space, target: id } }).toArray()
    if (pending.length && await this.#settle(tx, row, pending, clears, true)) {
      changed.add(row.type)
      return
    }
    if (opm) await this.#onePerMember(tx, row)
    await tx.insert('@hg/records', row)
    changed.add(row.type)
    if (record.type === 'hg/tag') await this.#retag(tx, enc.idBytes(values.on), changed)
  }

  // The tags on a record (research.md A9): per tag, the latest tag or untag
  // by someone who may edit it (its author, or an editor of a shared type,
  // cuts included) decides.
  async #tagKeys (tx, row) {
    if (row.type.startsWith('hg/')) return []
    const prefix = { space: row.space, target: row.id, type: 'hg/tag' }
    const best = new Map()
    for (const t of await tx.find('@hg/by-link', { gte: prefix, lte: prefix }).toArray()) {
      if (t.flags & (FLAGS.HIDDEN | FLAGS.REMOVED)) continue
      let v = null
      try { v = this.space.types.decode('hg/tag', t.fields, t.links) } catch { continue }
      if (!v.on || !b4a.equals(enc.idBytes(v.on), row.id)) continue
      if (!gate.mayEdit(this.space.types, { author: t.author, id: t.id }, row, this.space.state)) continue
      const prev = best.get(v.tag)
      if (!prev || compare(t, prev.t) > 0) best.set(v.tag, { t, off: !!v.off })
    }
    return [...best].filter(([, b]) => !b.off).map(([tag]) => tagKey(tag)).sort()
  }

  // A record's index keys: the app's and its tags.
  async #ix (tx, row, values) {
    return ixKeys(this.space.types, row.type, values).concat(await this.#tagKeys(tx, row))
  }

  // Recomputes the tags of record `id`, if held.
  async #retag (tx, id, changed) {
    const row = await tx.get('@hg/records', { space: this.space.key, id })
    if (!row) return
    let values = null
    try { values = this.space.types.has(row.type) ? this.space.types.decode(row.type, row.fields || EMPTY, row.links || []) : null } catch {}
    const ix = await this.#ix(tx, row, values)
    if (ix.join('\n') === (row.ix || []).join('\n')) return
    row.ix = ix
    await tx.insert('@hg/records', row)
    changed.add(row.type)
  }

  // The record a hg/tag row tags.
  #tagged (row) {
    try { return enc.idBytes(this.space.types.decode('hg/tag', row.fields, row.links).on) } catch { return null }
  }

  // A tag row went (or was hidden): its record's tags again.
  async #retagged (tx, row, changed) {
    const on = this.#tagged(row)
    if (on) await this.#retag(tx, on, changed)
  }

  // Edit rights changed (research.md A9: a permission given, or taken away
  // with a cut): edits of types editable by a permission, and tags on their
  // records, are judged again. Runs only when the members' rights over those
  // permissions changed.
  async reauthorize () {
    const types = this.space.types
    const shared = new Set(types.names().filter((n) => types.get(n).editable.by === 'permission'))
    if (!shared.size || this.closed) return
    const perms = new Set([...shared].map((n) => types.get(n).editable.permission))
    const state = this.space.state
    const rights = []
    for (const [id] of [...state.members].sort(byKey)) {
      const held = [...perms].filter((p) => state.can(id, p))
      if (held.length) rights.push([id, held])
    }
    const sig = JSON.stringify([rights, [...state.editcuts].sort(byKey)])
    if (sig === this.rights) return
    this.rights = sig
    const changed = new Set()
    const clears = []
    await this.queue.run(async (tx) => {
      const space = this.space.key
      const targets = new Map()
      for (const ch of await tx.find('@hg/changes', { gte: { space }, lte: { space } }).toArray()) {
        if (shared.has(ch.type)) targets.set(b4a.toString(ch.target, 'hex'), ch.target)
      }
      for (const t of await tx.find('@hg/by-type', { gte: { space, type: 'hg/tag' }, lte: { space, type: 'hg/tag' } }).toArray()) {
        const on = this.#tagged(t)
        if (on) targets.set(b4a.toString(on, 'hex'), on)
      }
      for (const id of targets.values()) {
        const row = await tx.get('@hg/records', { space, id })
        if (!row || !shared.has(row.type)) continue
        await this.#resettle(tx, row, clears)
        changed.add(row.type)
      }
    })
    for (const id of clears) await this.space.clear(id)
    this.space.changed(changed)
  }

  // Applies the allowed changes among `changes` to `row`. Returns true if the
  // row was deleted (or, for a new row, must not be inserted).
  async #settle (tx, row, changes, clears, fresh = false) {
    const state = this.space.state
    const allowed = changes.filter((ch) => gate.mayChange(this.space.types, ch, row, state))
    if (allowed.some((ch) => ch.kind === enc.DELETE)) {
      if (!fresh) await tx.delete('@hg/records', { space: row.space, id: row.id })
      clears.push(row.id)
      const all = await tx.find('@hg/changes', { gte: { space: row.space, target: row.id }, lte: { space: row.space, target: row.id } }).toArray()
      for (const ch of all) if (ch.kind === enc.EDIT) clears.push(ch.id)
      return true
    }
    let best = null
    for (const ch of allowed) if (!best || compare(ch, best) > 0) best = ch
    if (best && compare(best, { stamp: row.vstamp, device: row.vdevice }) > 0) {
      let values = null
      try { values = this.space.types.has(row.type) ? this.space.types.decode(row.type, best.fields, best.links) : null } catch {}
      row.vstamp = best.stamp
      row.vdevice = best.device
      row.fields = best.fields
      row.links = best.links
      row.ix = await this.#ix(tx, row, values)
      row.flags |= FLAGS.EDITED
      if (!fresh) await tx.insert('@hg/records', row)
    }
    return false
  }

  // A one-per-member group lost a row: the latest of the others counts again.
  async #regroup (tx, gone) {
    const key = { space: gone.space, type: gone.type, target: gone.target, author: gone.author }
    const rows = await tx.find('@hg/one-per-member', { gte: key, lte: key }).toArray()
    let best = null
    for (const r of rows) if (!b4a.equals(r.id, gone.id) && (!best || compare(r, best) > 0)) best = r
    for (const r of rows) {
      if (b4a.equals(r.id, gone.id)) continue
      const superseded = r !== best
      if (!!(r.flags & FLAGS.SUPERSEDED) === superseded) continue
      r.flags ^= FLAGS.SUPERSEDED
      await tx.insert('@hg/records', r)
    }
  }

  // Of a member's records of a one-per-member type for one target, only the
  // latest counts.
  async #onePerMember (tx, row) {
    const key = { space: row.space, type: row.type, target: row.target, author: row.author }
    for (const other of await tx.find('@hg/one-per-member', { gte: key, lte: key }).toArray()) {
      if (other.flags & FLAGS.SUPERSEDED) continue
      if (compare({ stamp: row.stamp, device: row.device }, { stamp: other.stamp, device: other.device }) > 0) {
        other.flags |= FLAGS.SUPERSEDED
        await tx.insert('@hg/records', other)
      } else {
        row.flags |= FLAGS.SUPERSEDED
      }
    }
  }

  close () {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
  }
}

// A row's flags with a record's moderation (hidden, flagged) applied.
function modFlags (flags, m) {
  flags &= ~(FLAGS.HIDDEN | FLAGS.FLAGGED)
  if (m.hidden) flags |= FLAGS.HIDDEN
  if (m.flagged) flags |= FLAGS.FLAGGED
  return flags
}

function logRow (space, log, indexed) {
  return { space: space.key, log: log.key, identity: log.identity, device: log.device, indexed, cut: log.cut, refused: false }
}

module.exports = { WriteQueue, Indexer, FLAGS, ixKeys, tagKey }
