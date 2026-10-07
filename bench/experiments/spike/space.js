// Throwaway spike (design brief): do the chosen pieces fit together, and does
// app code read like the brief's sketch? NOT the new core: no invites, devices,
// encryption, activity lists, schemas or bounded waits. Simplified on purpose:
//
//   - the decision log is the creator's Hypercore (one admin), not an Autobase;
//     entries: member (a writer's log key), ban (a log, cut at a length), hide
//   - each member writes records (JSON) to one log of its own
//   - in a small space the member list *is* the list of authors, so every
//     member opens every member's log and keeps everything
//   - every member indexes what it holds in HyperDB (experiment 2's definition)
//     and readers enforce the decisions (non-members never opened; banned logs
//     cut; hidden records skipped)

const path = require('path')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const HyperDB = require('hyperdb')
const def = require('../hyperdb/spec/hyperdb')

const hex = (b) => b.toString('hex')

class Space {
  constructor (dir, bootstrap, spaceKey = null) {
    this.store = new Corestore(path.join(dir, 'cores'))
    this.db = HyperDB.rocks(path.join(dir, 'index'), def)
    this.swarm = new Hyperswarm({ bootstrap })
    this.spaceKey = spaceKey
    this.members = new Map() // log hex -> { core, indexed, cut }
    this.hidden = new Set()
    this.lastT = 0
    this.listeners = new Set()
    this.writing = Promise.resolve() // HyperDB refuses to flush during another insert: one queue
    this.swarm.on('connection', (conn) => { conn.on('error', () => {}); this.store.replicate(conn) })
  }

  static async create (dir, bootstrap) {
    const space = new Space(dir, bootstrap)
    await space.#open()
    await space.decisions.append(Buffer.from(JSON.stringify({ op: 'member', log: hex(space.log.key) })))
    return space
  }

  static async join (dir, bootstrap, spaceKey) {
    const space = new Space(dir, bootstrap, spaceKey)
    await space.#open()
    return space
  }

  async #open () {
    this.log = this.store.get({ name: 'my-log' })
    await this.log.ready()
    this.decisions = this.spaceKey ? this.store.get({ key: this.spaceKey }) : this.store.get({ name: 'decisions' })
    await this.decisions.ready()
    this.spaceKey = this.decisions.key
    this.decisionsRead = 0
    this.decisions.on('append', () => this.#readDecisions())
    this.decisions.download({ start: 0, end: -1 })
    this.swarm.join(this.spaceKey, { server: true, client: true })
    await this.swarm.flush()
    await this.#readDecisions()
  }

  get key () { return this.spaceKey }
  get writerKey () { return this.log.key }

  // --- decisions (creator only in this spike) ---

  async addMember (logKey) { await this.#decide({ op: 'member', log: hex(logKey) }) }
  async ban (logKey, { keepUpTo }) { await this.#decide({ op: 'ban', log: hex(logKey), length: keepUpTo }) }
  async hide (id) { await this.#decide({ op: 'hide', id }) }

  async #decide (d) {
    if (!this.decisions.writable) throw new Error('only the space creator decides in this spike')
    await this.decisions.append(Buffer.from(JSON.stringify(d)))
  }

  async #readDecisions () {
    if (this.reading) return this.reading
    this.reading = (async () => {
      while (this.decisionsRead < this.decisions.length) {
        const d = JSON.parse(await this.decisions.get(this.decisionsRead++))
        if (d.op === 'member') await this.#openMember(d.log)
        else if (d.op === 'ban') await this.#cut(d.log, d.length)
        else if (d.op === 'hide') { this.hidden.add(d.id); this.#changed() }
      }
    })()
    try { await this.reading } finally { this.reading = null }
  }

  async #openMember (logHex) {
    if (this.members.has(logHex)) return
    const core = logHex === hex(this.log.key) ? this.log : this.store.get({ key: Buffer.from(logHex, 'hex') })
    const member = { core, indexed: 0, cut: Infinity, indexing: null }
    this.members.set(logHex, member)
    await core.ready()
    core.on('append', () => this.#index(member))
    if (!core.writable) core.download({ start: 0, end: -1 })
    await this.#index(member)
  }

  // Readers enforce a ban: records at or past the cut leave the index and are
  // never indexed again.
  async #cut (logHex, length) {
    const member = this.members.get(logHex)
    if (!member) return
    member.cut = Math.min(member.cut, length)
    if (member.indexing) await member.indexing
    await this.#exclusive(async () => {
      for (let seq = length; seq < member.indexed; seq++) {
        const rec = await this.db.get('@hg/records', { id: `${logHex}:${seq}` })
        if (rec) await this.db.delete('@hg/records', rec)
      }
      await this.db.flush()
    })
    this.#changed()
  }

  #exclusive (fn) {
    const run = this.writing.then(fn)
    this.writing = run.catch(() => {})
    return run
  }

  async #index (member) {
    if (member.indexing) return member.indexing
    member.indexing = (async () => {
      const logHex = hex(member.core.key)
      let added = 0
      while (member.indexed < Math.min(member.core.length, member.cut)) {
        const seq = member.indexed++
        const r = JSON.parse(await member.core.get(seq))
        await this.#exclusive(() => this.db.insert('@hg/records', {
          id: `${logHex}:${seq}`,
          type: r.type,
          author: logHex,
          t: r.t,
          links: r.links,
          ix: [],
          body: Buffer.from(JSON.stringify(r.fields))
        }))
        added++
      }
      if (added) { await this.#exclusive(() => this.db.flush()); this.#changed() }
    })()
    try { await member.indexing } finally { member.indexing = null }
  }

  #changed () { for (const fn of this.listeners) fn() }

  // --- the app's API (the brief's sketch) ---

  async put (type, fields = {}) {
    const links = []
    const own = {}
    for (const [k, v] of Object.entries(fields)) {
      if (k === 'on') links.push(typeof v === 'string' ? v : v.id)
      else own[k] = v
    }
    // Later of the clock and one more than the newest own record seen.
    this.lastT = Math.max(Date.now(), this.lastT + 1)
    const seq = this.log.length
    await this.log.append(Buffer.from(JSON.stringify({ type, t: this.lastT, links, fields: own })))
    return { id: `${hex(this.log.key)}:${seq}`, type, ...own }
  }

  #shape (rec) {
    return { id: rec.id, type: rec.type, author: rec.author, t: rec.t, on: rec.links[0] || null, ...JSON.parse(rec.body) }
  }

  #visible (rec) { return !this.hidden.has(rec.id) }

  query (type) {
    return {
      latest: async (n) => {
        const out = []
        const stream = this.db.find('@hg/by-type', { gte: { type }, lte: { type } }, { reverse: true })
        for await (const rec of stream) {
          if (this.#visible(rec)) out.push(this.#shape(rec))
          if (out.length === n) { await stream.destroy(); break }
        }
        return out
      },
      live: (fn, n = 20) => {
        const run = async () => fn(await this.query(type).latest(n))
        this.listeners.add(run)
        run()
        return () => this.listeners.delete(run)
      }
    }
  }

  async linked (target, type) {
    const id = typeof target === 'string' ? target : target.id
    const out = []
    for await (const rec of this.db.find('@hg/by-link', { gte: `${id}|`, lt: `${id}|~` })) {
      if ((!type || rec.type === type) && this.#visible(rec)) out.push(this.#shape(rec))
    }
    return out
  }

  // One per member per target: the latest counts.
  async sum (type, field, { on }) {
    const latest = new Map()
    for (const r of await this.linked(on, type)) {
      const held = latest.get(r.author)
      if (!held || r.t > held.t) latest.set(r.author, r)
    }
    let total = 0
    for (const r of latest.values()) total += r[field]
    return total
  }

  async close () {
    await this.swarm.destroy()
    await this.db.close()
    await this.store.close()
  }
}

module.exports = { Space }
