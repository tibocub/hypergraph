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
const safetyCatch = require('safety-catch')
const enc = require('../encodings.js')
const gate = require('../gate.js')
const { compare } = require('../stamp.js')

const FLAGS = { HIDDEN: 1, REMOVED: 2, SUPERSEDED: 4, EDITED: 8 }
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

// Indexes one space's logs. `space` gives: key, types, state (decisions),
// me (identity), stamper, changed(types), clear(id).
class Indexer {
  constructor (space, queue) {
    this.space = space
    this.queue = queue
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
    log.indexing = this.#run(log).catch(safetyCatch).finally(() => { log.indexing = null })
    return log.indexing
  }

  // A block arrived. Below `scanned` it may be a hole, or about to become one
  // (the scan is looking at it): the run checks.
  arrived (log, seq) {
    if (seq < log.scanned) log.arrived.add(seq)
  }

  // Record `id` was deleted by its author: if its block is a hole, it's done.
  wiped (id, author) {
    const { log: key, seq } = enc.idParts(id)
    const log = this.space.logOf(key)
    if (!log || !b4a.equals(log.identity, author) || !log.holes.has(seq)) return
    log.holes.delete(seq)
    this.index(log).catch(safetyCatch)
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
        await this.queue.run(async (tx) => {
          for (const [s, bytes] of batch) if (s > 0) await this.#one(tx, log, s, bytes, changed, clears, wiped)
          await tx.insert('@hg/logs', { space: this.space.key, log: log.key, identity: log.identity, device: log.device, indexed, cut: null, refused: false })
        })
        log.indexed = indexed
        for (const id of clears) await this.space.clear(id)
        for (const [id, author] of wiped) this.wiped(id, author)
        this.space.changed(changed)
      }
    } while (log.again)
  }

  // Is the missing block `seq` of `log` one its author deleted?
  async #wipedByAuthor (log, seq) {
    if (seq === 0) return false
    const target = enc.idBytes({ log: log.key, seq })
    const changes = await this.queue.db.find('@hg/changes', { gte: { space: this.space.key, target }, lte: { space: this.space.key, target } }).toArray()
    return changes.some((ch) => ch.kind === enc.DELETE && b4a.equals(ch.author, log.identity))
  }

  async #one (tx, log, seq, bytes, changed, clears, wiped) {
    const { types, key: space } = this.space
    const res = gate.checkRecord(bytes, types)
    if (!res.ok) return
    const { record, values } = res
    if (b4a.equals(log.identity, this.space.me)) this.space.stamper.seen(record.stamp)
    const id = enc.idBytes({ log: log.key, seq })

    if (record.kind !== enc.PUT) {
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
      flags: 0,
      opm,
      target: opm ? (decl.target && values[decl.target] ? enc.idBytes(values[decl.target]) : EMPTY) : null
    }

    const pending = await tx.find('@hg/changes', { gte: { space, target: id }, lte: { space, target: id } }).toArray()
    if (pending.length && await this.#settle(tx, row, pending, clears, true)) {
      changed.add(row.type)
      return
    }
    if (opm) await this.#onePerMember(tx, row)
    await tx.insert('@hg/records', row)
    changed.add(row.type)
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
      row.ix = ixKeys(this.space.types, row.type, values)
      row.flags |= FLAGS.EDITED
      if (!fresh) await tx.insert('@hg/records', row)
    }
    return false
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
  }
}

module.exports = { WriteQueue, Indexer, FLAGS, ixKeys }
