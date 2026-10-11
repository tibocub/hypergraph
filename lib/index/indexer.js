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
const symbols = require('../symbols.js')
const { compare } = require('../stamp.js')
const { ixCost } = require('../storage.js')
const { derive, WIPED } = require('../activity.js')
const { judge } = require('../limit.js')

// DROPPED: the content was dropped here (story 6: the row stays, without
// fields); READ: fetched back by a read (dropped last); UNREADABLE: a record
// written in the clear in a private space (story 8: listed, no content).
const FLAGS = { HIDDEN: 1, REMOVED: 2, SUPERSEDED: 4, EDITED: 8, FLAGGED: 16, DROPPED: 32, READ: 64, UNREADABLE: 128 }
const BATCH = 256 // blocks per transaction
const EMPTY = b4a.alloc(0)
const SUPERSEDED = new Set(['hg/setting', 'hg/heads']) // personal records only the latest of counts

// One write queue per instance: every change to the index runs alone, in a
// transaction committed at its end (the spike: HyperDB refuses to commit
// during another insert). A task that throws commits nothing.
class WriteQueue {
  constructor (db) {
    this.db = db
    this.tail = Promise.resolve()
    // Tests only (lib/testing.js crashAfter): after this many indexing
    // batches, nothing commits any more, as if the process had died.
    this.crashAfter = WriteQueue[symbols.crashAfter] ?? null
    WriteQueue[symbols.crashAfter] = null
    this.crashed = false
  }

  // `batch`: an indexing batch (counted by the crash seam).
  run (fn, { batch = false } = {}) {
    const task = this.tail.then(async () => {
      if (this.crashAfter !== null && batch && this.crashAfter-- <= 0) this.crashed = true
      if (this.crashed) throw new Error('This instance crashed (a test)')
      const tx = this.db.transaction()
      try {
        const result = await fn(tx)
        if (this.slow) await new Promise((resolve) => setTimeout(resolve, this.slow)) // tests only (lib/testing.js slowCommits)
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
// A record whose indexed fields are all empty isn't in that index (story 7:
// all the records of an app version that didn't have the field yet).
function ixKeys (types, type, values) {
  if (!values || !types.has(type)) return []
  return types.get(type).index
    .filter((fields) => fields.some((f) => values[f] !== null && values[f] !== undefined))
    .map((fields) => fields.join(',') + '\0' + fields.map((f) => String(values[f] ?? '')).join('\0'))
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
    this.blocks = 0 // blocks indexed since opening
    this.prior = null // { changes, tags }: held in the index when it opened (#before)
    this.had = null
    this.changeTargets = new Set() // targets of edits and deletes indexed since opening (hex)
    this.tagged = new Set() // records tagged since opening (hex)
    this.timers = new Set()
    this.dirty = new Set() // logs whose counters changed in the running task
    this.closed = false
  }

  // A task on the index; the counters of the logs it touched (dropped
  // content, index entry bytes) are saved in the same transaction.
  #tx (fn, opts) {
    return this.queue.run(async (tx) => {
      const result = await fn(tx)
      for (const log of this.dirty) await tx.insert('@hg/meta', droppedRow(this.space, log))
      this.dirty.clear()
      return result
    }, opts)
  }

  // A row's index keys went from `before` to `after` (deleted: []): its log's
  // index entry bytes, for the storage estimate (core follow-ups, item 5).
  #account (row, before, after) {
    const delta = ixCost(after) - ixCost(before)
    const log = delta && this.space.logOf(row.log)
    if (!log) return
    log.ixBytes = Math.max(0, (log.ixBytes || 0) + delta)
    this.dirty.add(log)
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
      log.uncommitted = false
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
    if (log.from === null || seq < log.from) return // fetched to check an activity entry, not read (story 9)
    if (seq < log.scanned) log.arrived.add(seq)
  }

  // Block k's stamp for the write limit: WIPED if known wiped; null if not
  // here (fetched in the background: the hole that waits is looked at again).
  async #stampAt (log, k, stamps = null) {
    const known = (stamps && stamps.get(k)) ?? (log.overStamps && log.overStamps.get(k))
    if (known !== undefined) return known
    const bytes = await log.core.get(k, { wait: false }).catch(() => null)
    if (bytes) return stampOf(bytes)
    if (await this.#wipedByAuthor(log, k)) return WIPED
    log.core.get(k, { timeout: 10000 }).catch(() => {})
    return null
  }

  // The write limit changed, or block `wiped` of `log` was wiped (story 9):
  // the records of `log` from `from` to `to` are judged again; those over
  // it now go. A limit raised or lifted reads the log again from its start,
  // so records refused before come back (their authors hold them).
  async rejudge (log, { from = log.from || 1, to = Infinity, again = false } = {}) {
    const limit = this.space.limitFor(log)
    if (log.from === null || this.closed) return
    const end = Math.min(log.scanned, to + 1, log.limit)
    const over = []
    if (limit) {
      for (let s = Math.max(from, 1); s < end; s++) {
        const bytes = await log.core.get(s, { wait: false }).catch(() => null)
        if (!bytes || unlimited(bytes)) continue
        if (await judge(s, stampOf(bytes), limit, (k) => this.#stampAt(log, k)) === 'over') over.push(s)
      }
    }
    if (over.length) {
      const changed = new Set()
      const clears = []
      await this.#tx(async (tx) => {
        for (const s of over) await this.#uncount(tx, log, s, changed, clears)
      })
      for (const s of over) {
        if (!log.overStamps) log.overStamps = new Map()
        log.overStamps.set(s, stampOf(await log.core.get(s, { wait: false })))
        if (!log.own) clears.push(enc.idBytes({ log: log.key, seq: s }))
      }
      for (const id of clears) await this.space.clear(id, { dropped: true })
      this.space.changed(changed)
    }
    if (again && log.from !== null) { // records refused before may count now
      log.overStamps = null
      log.rescanned = true
      log.skip = null
      log.scanned = log.indexed = log.from
      this.space.restart(log)
      this.index(log).catch(safetyCatch)
    }
  }

  // Is block `seq` of `log` known to be wiped (deleted by its author, or
  // taken down)?
  isWiped (log, seq) {
    return this.#wipedByAuthor(log, seq)
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
    await this.#tx(async (tx) => {
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
    this.#account(row, row.ix, [])
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

  // Did this space's index hold edits or tags when it opened? If not (a new
  // space, or an index being rebuilt), a record arriving needs no lookup for
  // edits or tags that came before it, unless one came since (story 6:
  // iterators were most of a rebuild's time).
  #before () {
    if (!this.prior) {
      const space = this.space.key
      const db = this.queue.db
      this.prior = Promise.all([
        db.findOne('@hg/changes', { gte: { space }, lte: { space } }),
        db.findOne('@hg/by-type', { gte: { space, type: 'hg/tag' }, lte: { space, type: 'hg/tag' } }),
        db.findOne('@hg/records', { gte: { space }, lte: { space } })
      ]).then(([change, tag, record]) => ({ changes: !!change, tags: !!tag, records: !!record }))
    }
    return this.prior
  }

  async #run (log) {
    this.had = await this.#before()
    if (log.from === null) return // not read here yet (story 9: a big space's log outside the periods read)
    do {
      log.again = false
      for (;;) {
        if (this.closed) return
        const batch = []
        const stamps = new Map() // the batch's record stamps, for activity entries
        // Until this batch is committed, what it looked at isn't in the index:
        // the log counts as missing something (lib/replication.js), so no read
        // says "complete" in between (found by bench/next/first-page.js).
        log.uncommitted = true
        for (const seq of log.arrived) {
          if (batch.length >= BATCH) break
          log.arrived.delete(seq)
          const bytes = log.holes.has(seq) ? await log.core.get(seq, { wait: false }) : null
          if (bytes) batch.push([seq, bytes])
        }
        const end = Math.min(log.core.length, log.limit)
        while (batch.length < BATCH && log.scanned < end) {
          if (log.skip && log.scanned >= log.skip.from) { // done before the horizon widened (story 9)
            if (log.scanned < log.skip.to) log.scanned = Math.min(log.skip.to, end)
            log.skip = null
            continue
          }
          const seq = log.scanned++
          const bytes = await log.core.get(seq, { wait: false })
          if (bytes) batch.push([seq, bytes])
          else if (!(await this.#wipedByAuthor(log, seq))) log.holes.add(seq)
        }
        // A private space's record whose epoch key isn't held here stays a
        // hole (missing for "complete") until the key arrives (story 8).
        for (const [seq, bytes] of batch) if (seq > 0) stamps.set(seq, stampOf(bytes))
        for (let i = batch.length - 1; i >= 0; i--) {
          if (batch[i][0] > 0 && this.space.locked(batch[i][1])) {
            log.holes.add(batch[i][0])
            batch.splice(i, 1)
          } else {
            log.holes.delete(batch[i][0])
          }
        }
        // An open space's write limit (story 9, T071a): a record beyond it
        // counts for nobody, and its block goes (not from this device's own
        // log); its stamp is remembered, as later judgments need it.
        const overs = []
        const limit = this.space.limitFor(log)
        if (limit) {
          for (let i = batch.length - 1; i >= 0; i--) {
            const [seq, bytes] = batch[i]
            if (seq === 0 || unlimited(bytes)) continue
            const v = await judge(seq, stamps.get(seq), limit, (k) => this.#stampAt(log, k, stamps))
            if (v === 'ok') continue
            batch.splice(i, 1)
            if (v === 'wait') {
              log.holes.add(seq)
              continue
            }
            log.holes.delete(seq)
            if (!log.overStamps) log.overStamps = new Map()
            log.overStamps.set(seq, stamps.get(seq))
            if (!log.own) overs.push(enc.idBytes({ log: log.key, seq }))
          }
        }
        const indexed = log.holes.size ? lowest(log.holes) : log.scanned
        if (!batch.length && indexed === log.indexed) {
          log.uncommitted = false
          await this.#derive(log, stamps)
          break
        }
        const changed = new Set()
        const clears = []
        const wiped = []
        const removals = []
        await this.#tx(async (tx) => {
          for (const [s, bytes] of batch) if (s > 0) await this.#one(tx, log, s, bytes, changed, clears, wiped, removals)
          await tx.insert('@hg/logs', logRow(this.space, log, indexed))
        }, { batch: true })
        this.blocks += batch.length
        log.indexed = indexed
        log.uncommitted = false
        for (const id of clears) await this.space.clear(id)
        for (const id of overs) await this.space.clear(id, { dropped: true }) // not wiped: its author holds it
        for (const [id, author] of wiped) this.wiped(id, author)
        for (const [values, identity] of removals) this.space.removed(values, identity)
        this.space.changed(changed)
        await this.#derive(log, stamps)
      }
    } while (log.again)
  }

  // Activity entries (story 9, research.md A14): the first record of each
  // period, from the blocks looked at, in order; stops at a block not held
  // (and not known to be wiped). New ones (or lower starts) are kept in the
  // index and passed on (space.activityKept).
  async #derive (log, stamps) {
    if (log.from === null || this.closed) return
    const end = Math.min(log.scanned, log.limit, log.core.length)
    const act = log.act
    const got = []
    for (let seq = act.next; seq < end; seq++) {
      let s = stamps.get(seq) ?? (log.overStamps && log.overStamps.get(seq))
      if (s === undefined) {
        const bytes = await log.core.get(seq, { wait: false }).catch(() => null)
        s = bytes ? stampOf(bytes) : (await this.#wipedByAuthor(log, seq) ? WIPED : null)
      }
      if (s === null) break
      got.push(s)
    }
    if (!got.length) return
    const res = derive((seq) => got[seq - act.next], { from: act.next, end: act.next + got.length, last: act.last, period: act.period })
    log.act = { next: res.next, last: res.last, period: res.period }
    const kept = []
    await this.#tx(async (tx) => {
      this.dirty.add(log)
      for (const e of res.entries) {
        const row = { space: this.space.key, period: e.period, log: log.key, start: e.start }
        const old = await tx.get('@hg/activity', row)
        if (old && old.start <= e.start) continue
        await tx.insert('@hg/activity', row)
        kept.push(row)
      }
    })
    if (kept.length) this.space.activityKept(kept)
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
    await this.#tx(async (tx) => {
      for (let seq = Math.max(limit, log.from || 1, 1); seq < upto; seq++) await this.#uncount(tx, log, seq, changed, clears)
      log.indexed = log.holes.size ? lowest(log.holes) : log.scanned
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
      this.#account(row, row.ix, [])
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
    const before = row.ix
    const log = this.space.logOf(row.log)
    const bytes = log ? await log.core.get(row.seq, { wait: false }) : null
    if (bytes) {
      const put = this.space.unseal(log, row.seq, enc.decodeRecord(bytes)) || { stamp: row.stamp, fields: EMPTY, links: [] }
      let values = null
      try { values = this.space.types.has(row.type) ? this.space.types.decode(row.type, put.fields, put.links) : null } catch {}
      row.vstamp = put.stamp
      row.vdevice = row.device
      row.fields = put.fields
      row.links = put.links
      row.ix = await this.#ix(tx, row, values)
      row.flags &= ~FLAGS.EDITED
    } else {
      // Its first version's content was dropped here (story 6): back to it,
      // without content, unless an edit gives it again.
      row.vstamp = row.stamp
      row.vdevice = row.device
      row.fields = EMPTY
      row.flags = (row.flags | FLAGS.DROPPED) & ~FLAGS.EDITED
    }
    const changes = await tx.find('@hg/changes', { gte: { space: row.space, target: row.id }, lte: { space: row.space, target: row.id } }).toArray()
    if (await this.#settle(tx, row, changes, clears, true)) {
      await tx.delete('@hg/records', { space: row.space, id: row.id })
      this.#account(row, before, [])
    } else {
      await tx.insert('@hg/records', row)
      this.#account(row, before, row.ix)
    }
  }

  async #one (tx, log, seq, bytes, changed, clears, wiped, removals) {
    if (seq >= log.limit) return // cut while this batch waited
    const { types, key: space } = this.space
    const res = gate.checkRecord(bytes, types, (r) => this.space.unseal(log, seq, r))
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
      this.changeTargets.add(b4a.toString(record.target, 'hex'))
      const row = await tx.get('@hg/records', { space, id: record.target })
      if (row && await this.#settle(tx, row, [change], clears)) changed.add(row.type)
      if (!row && record.kind === enc.DELETE) wiped.push([record.target, log.identity])
      return
    }

    // Indexed before? (blocks past `indexed` are looked at again after a
    // restart, or after reading a log from earlier on: story 9.) Not if the
    // index held no records of this space when it opened: within one run each
    // block is looked at once.
    if ((this.had.records || log.rescanned) && await tx.get('@hg/records', { space, id })) return

    // A record is kept whatever its links point at: a link field's allowed
    // targets are judged when read (lib/space.js, research.md A12), so no
    // order of arrival can make members differ.
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

    const decl = types.has(record.type) && !record.unreadable ? types.get(record.type) : null
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
      flags: modFlags(0, this.space.state.moderation(id)) | (record.unreadable ? FLAGS.UNREADABLE : 0),
      opm,
      target: opm ? (decl.target && values[decl.target] ? enc.idBytes(values[decl.target]) : EMPTY) : null
    }
    row.ix = row.ix.concat(await this.#tagKeys(tx, row))

    const mayHave = this.had.changes || this.changeTargets.has(b4a.toString(id, 'hex'))
    const pending = mayHave ? await tx.find('@hg/changes', { gte: { space, target: id }, lte: { space, target: id } }).toArray() : []
    if (pending.length && await this.#settle(tx, row, pending, clears, true)) {
      changed.add(row.type)
      return
    }
    if (opm) await this.#onePerMember(tx, row)
    if (this.space.personal && SUPERSEDED.has(row.type) && await this.#supersede(tx, row, log, clears)) return
    await tx.insert('@hg/records', row)
    this.#account(row, [], row.ix)
    changed.add(row.type)
    if (record.type === 'hg/tag' && values) {
      this.tagged.add(b4a.toString(enc.idBytes(values.on), 'hex'))
      await this.#retag(tx, enc.idBytes(values.on), changed)
    }
  }

  // Superseded personal-space records (ROADMAP 2026-10-09, research.md A10):
  // of the settings of one name, and of the heads of one device, only the
  // latest row is kept; the older ones' blocks are cleared, except in this
  // device's own logs, which stay whole (FR-027: the other devices fetch and
  // check them, so none meets a hole nobody can fill). True if `row` itself
  // is the older one (then it isn't inserted).
  async #supersede (tx, row, log, clears) {
    const space = row.space
    let others
    if (row.type === 'hg/setting') {
      const prefix = { space, type: row.type, ix: row.ix[0] }
      others = await tx.find('@hg/by-ix', { gte: prefix, lte: prefix }).toArray()
    } else {
      const prefix = { space, type: row.type }
      others = (await tx.find('@hg/by-type', { gte: prefix, lte: prefix }).toArray()).filter((r) => b4a.equals(r.device, row.device))
    }
    let newest = row
    for (const o of others) if (compare(o, newest) > 0) newest = o
    const own = (key) => { const l = this.space.logOf(key); return !!(l && l.own) }
    for (const o of others) {
      if (o === newest || b4a.equals(o.id, row.id)) continue
      await tx.delete('@hg/records', { space, id: o.id })
      this.#account(o, o.ix, [])
      if (!own(o.log)) clears.push(o.id)
    }
    if (newest === row) return false
    if (!log.own) clears.push(row.id)
    return true
  }

  // The tags on a record (research.md A9): per tag, the latest tag or untag
  // by someone who may edit it (its author, or an editor of a shared type,
  // cuts included) decides.
  async #tagKeys (tx, row) {
    if (row.type.startsWith('hg/')) return []
    if (this.had && !this.had.tags && !this.tagged.has(b4a.toString(row.id, 'hex'))) return [] // never tagged
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
    this.#account(row, row.ix, ix)
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
    await this.#tx(async (tx) => {
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
      if (!fresh) {
        await tx.delete('@hg/records', { space: row.space, id: row.id })
        this.#account(row, row.ix, [])
      }
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
      const before = row.ix
      row.ix = await this.#ix(tx, row, values)
      row.flags = (row.flags | FLAGS.EDITED) & ~FLAGS.DROPPED // the edit's content is here
      if (!fresh) {
        await tx.insert('@hg/records', row)
        this.#account(row, before, row.ix)
      }
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

  // --- holding part of a space (story 6, research.md A10) ---

  // Drops the content of `rows` (chosen by the space, oldest first): their
  // rows stay (counts, links, tags and edits are unchanged), flagged DROPPED,
  // without fields; their blocks are cleared. Only below a log's `indexed`,
  // so downloads (which start there) never fetch them again. Returns
  // { logs, bytes }: the logs touched and the bytes of blocks dropped.
  async drop (rows) {
    const clears = []
    const touched = new Set()
    let dropped = 0
    if (this.closed) return { logs: [], bytes: 0 }
    await this.#tx(async (tx) => {
      for (const r of rows) {
        const row = await tx.get('@hg/records', { space: r.space, id: r.id })
        if (!row || (row.flags & FLAGS.DROPPED)) continue
        const log = this.space.logOf(row.log)
        if (!log || log.own || row.seq >= log.indexed) continue
        const bytes = await log.core.get(row.seq, { wait: false })
        row.fields = EMPTY
        row.flags = (row.flags | FLAGS.DROPPED) & ~FLAGS.READ
        await tx.insert('@hg/records', row)
        if (!bytes) continue // an edited record whose first version went already
        log.dropped += bytes.byteLength
        log.droppedBlocks++
        dropped += bytes.byteLength
        clears.push(row.id)
        touched.add(log)
      }
      for (const log of touched) this.dirty.add(log)
    })
    for (const id of clears) await this.space.clear(id, { dropped: true })
    return { logs: [...touched], bytes: dropped }
  }

  // A dropped record's content is back (fetched for a read, or to hold
  // everything again): `fields` are its current version's, `size` the bytes
  // of its block fetched again (0: taken from its latest edit). The row, or
  // null if it isn't a dropped one any more.
  async restore (id, fields, { read = true, size = 0 } = {}) {
    let out = null
    if (this.closed) return null
    await this.#tx(async (tx) => {
      const row = await tx.get('@hg/records', { space: this.space.key, id })
      if (!row || !(row.flags & FLAGS.DROPPED)) return
      row.fields = fields
      row.flags = (row.flags & ~FLAGS.DROPPED) | (read ? FLAGS.READ : 0)
      await tx.insert('@hg/records', row)
      const log = this.space.logOf(row.log)
      if (log && size) {
        log.dropped = Math.max(0, log.dropped - size)
        log.droppedBlocks = Math.max(0, log.droppedBlocks - 1)
        this.dirty.add(log)
      }
      out = row
    })
    return out
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

// A log's counters, kept with the index's own settings (the `log` schema is
// compact and can't grow): how much content was dropped from it (story 6),
// and what its rows' index entries cost (`ix`, core follow-ups).
function droppedRow (space, log) {
  const name = droppedName(space.key, log.key)
  return { name, value: b4a.from(JSON.stringify({ bytes: log.dropped, blocks: log.droppedBlocks, ix: log.ixBytes || 0, from: log.from, act: log.act })) }
}

// Records the write limit never refuses (they still take their place in the
// log): deletes (taking one's own record down is always allowed), grants and
// key links (a private space's keys) and device removals.
function unlimited (bytes) {
  try {
    const r = enc.decodeRecord(bytes)
    return r.kind === enc.DELETE || r.type === 'hg/grant' || r.type === 'hg/key-link' || r.type === 'hg/device-remove'
  } catch {
    return false
  }
}

// A record block's stamp (activity entries); WIPED for one that doesn't
// decode (no stamp anyone can read).
function stampOf (bytes) {
  try { return enc.decodeRecord(bytes).stamp } catch { return WIPED }
}

// The lowest of a set of numbers (a spread of a big set overflows the stack).
function lowest (set) {
  let min = Infinity
  for (const n of set) if (n < min) min = n
  return min
}

const droppedName = (space, log) => `dropped:${b4a.toString(space, 'hex')}:${b4a.toString(log, 'hex')}`

function logRow (space, log, indexed) {
  return { space: space.key, log: log.key, identity: log.identity, device: log.device, indexed, cut: log.cut, refused: false }
}

module.exports = { WriteQueue, Indexer, FLAGS, ixKeys, tagKey, droppedName }
