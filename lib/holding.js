// Spec 023: circles keeping each other's spaces online (the logic without
// network is lib/circles.js). One per instance.
//
// Holding (a device with setHolding on): a blind peer inside the instance
// (research R1, test/next/net/circles-spike.js), on the instance's own store
// and swarm, so held cores are served by the replication the instance runs
// anyway; only its records sit in their own folder (`holding`). It takes
// cores only from its circles' members (their holding client keys, from the
// circles' `hg/holder` records), and joins each held space's topic itself
// (its key comes as the request's referrer), so anyone in that space finds it
// without the space's settings changing. Nothing is announced through the
// blind peer: every held core is a plain record, dropped by our own gc.
//
// Handing (every device in a circle): the spaces this device holds, private
// first, the newest activity first, up to MEMBER_BYTES (the sender keeps the
// per-member cap: spec's shortcut), each core handed with blind-peering to
// every member device holding (`pick`: all of them), again when it grew. A
// closed space is handed from the list of its cores saved when it was last
// open (or opened once, if never seen open since).
//
// Leaving and removal: a holder forgets what a member handed once no circle
// of its own still holds that member, and deletes a core nobody covers.

const path = require('path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const BlindPeer = require('blind-peer')
const BlindPeering = require('blind-peering')
const safetyCatch = require('safety-catch')
const { plan, uncovered, MEMBER_BYTES, SHARE_BYTES } = require('./circles.js')

const hex = (b) => b4a.toString(b, 'hex')
const HAND_MS = 10000 // a hand-off not acknowledged within this is tried again at the next change
const FIT_MS = 2000 // how often a holder checks it fits its share
const FETCH_MS = 30000 // a hand-off not downloaded within this waits for the next one
const RECORDS = 1000 // hg/holder records read per circle, newest first

// A blind peer that takes cores from trusted clients only (circle members).
class Holder extends BlindPeer {
  async _onaddcores (stream, request) {
    if (!this._isTrustedPeer(stream.remotePublicKey)) throw new Error('Not a member of a circle held here')
    return super._onaddcores(stream, request)
  }

  async _onaddcore (stream, record) {
    if (!this._isTrustedPeer(stream.remotePublicKey)) throw new Error('Not a member of a circle held here')
    return super._onaddcore(stream, record)
  }

  // the swarm is the instance's: once closed, it must leave its connections alone
  _onconnection (conn) {
    if (this.closing) return
    super._onconnection(conn)
  }
}

class Holding {
  constructor (hg) {
    this.hg = hg
    this.on = false
    this.bytes = SHARE_BYTES
    this.memberBytes = MEMBER_BYTES // lib/testing.js memberBytes lowers it
    this.client = null // this device's holding client key pair (trusted by holders)
    this.circles = [] // [{ space, members: Set hex, records: [{ identity, device, client, on }] }]
    this.server = null
    this.trusted = new Map() // client key hex -> member identity hex
    this.held = new Map() // core hex -> Set of member identities hex who handed it
    this.info = new Map() // core hex -> { space hex, at, priority }
    this.topics = new Map() // space hex -> discovery
    this.fetching = new Map() // core hex -> length to download (#fetch)
    this.fetchRunning = false
    this.peering = null
    this.keys = '' // the holders the peering runs with (device keys hex, joined)
    this.holders = [] // device keys hex
    this.kept = new Map() // holder device hex -> Map core hex -> length it acknowledged
    this.handList = [] // [{ key, length }] what this device hands, as of the last pass
    this.saved = new Map() // space hex -> signature of its saved core list
    this.running = null
    this.again = false
    this.timer = null
    this.fitTimer = null
    this.saveTimer = null
    this.closed = false
  }

  get active () { return this.on || this.circles.length > 0 }

  async open () {
    const hg = this.hg
    const saved = (await hg._meta('holding')) || {}
    this.on = !!saved.on
    this.bytes = saved.bytes || SHARE_BYTES
    for (const [k, v] of Object.entries((await hg._meta('held')) || {})) {
      this.held.set(k, new Set(v.by))
      this.info.set(k, { space: v.space, at: v.at, priority: v.priority })
    }
    for (const [h, m] of Object.entries((await hg._meta('kept')) || {})) this.kept.set(h, new Map(Object.entries(m)))
    this.client = await hg.store.createKeyPair('hypergraph/holding')
  }

  used () {
    return this.server && this.server.db && this.server.digest ? Math.max(0, this.server.digest.bytesAllocated) : 0
  }

  async set ({ on, bytes }) {
    this.on = on
    if (bytes !== undefined) this.bytes = bytes
    await this.hg._setMeta('holding', { on: this.on, bytes: this.bytes })
    await this.update()
    if (this.on) await this.#fit()
  }

  // --- what changed: the circles, a space's records, the list, the network ---

  // Recomputes everything, one run at a time (a call during one runs another after it).
  update () {
    if (this.closed) return Promise.resolve()
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.#updateOnce().catch(safetyCatch).finally(() => {
      this.running = null
      if (this.again && !this.closed) {
        this.again = false
        this.update()
      }
    })
    return this.running
  }

  // A space changed (lib/space.js): a circle's records, or something to hand again.
  changed (space = null) {
    if (this.closed || !(this.active || (space && space.circle))) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.update(), 500)
    if (this.timer.unref) this.timer.unref()
  }

  async #updateOnce () {
    const hg = this.hg
    if (!hg._opened || hg.closed) return // at the end of Hypergraph.open
    const me = hex(hg._identity.publicKey)
    this.circles = await this.#view(me)
    for (const c of this.circles) await this.#writeOwn(c.space).catch(safetyCatch)
    const holders = new Set()
    const trusted = new Map()
    const covered = new Set()
    for (const c of this.circles) {
      for (const r of c.records) {
        if (r.identity === me) continue
        if (r.on) holders.add(r.device)
        trusted.set(r.client, r.identity)
      }
      for (const m of c.members) if (m !== me) covered.add(m)
    }
    this.trusted = trusted
    if (this.on) await this.#serve(covered)
    else await this.#stopServing()
    this.#statusChanged()
    await this.#handTo([...holders].sort())
    this.#statusChanged()
  }

  #statusChanged () {
    for (const c of this.circles) if (c.space.opened && !c.space.closed) c.space._statusChanged()
  }

  // The circles this person is in (left ones not), each with its members and
  // the latest hg/holder record of each of their devices.
  async #view (me) {
    const out = []
    for (const s of [...this.hg._spaces.values()]) {
      if (s.personal || !(s._circle || (s.opened && s.circle))) continue
      if (!s.opened && !s.closed) await s._ready().catch(safetyCatch) // circles are seeded: open
      if (!s.opened || s.closed || !s.circle) continue
      let items = []
      try { items = (await s.query('hg/holder').latest(RECORDS)).items } catch (err) { safetyCatch(err) }
      const byDevice = new Map()
      const left = new Map() // identity -> left, from its newest record
      for (const r of items) {
        const identity = hex(z32.decode(r.author))
        if (!left.has(identity)) left.set(identity, !!r.left)
        const device = hex(z32.decode(r.device))
        if (!byDevice.has(device) && b4a.isBuffer(r.client) && r.client.byteLength === 32) byDevice.set(device, { identity, device, client: hex(r.client), on: !!r.on, left: !!r.left })
      }
      const members = new Set([...s.state.members.keys()].filter((id) => !left.get(id)))
      if (!members.has(me)) continue
      out.push({ space: s, members, records: [...byDevice.values()].filter((r) => members.has(r.identity)), mine: byDevice.get(hex(this.hg._identity.device.publicKey)) || null })
    }
    return out
  }

  // This device's record in a circle: its client key and whether it holds.
  async #writeOwn (space) {
    const c = this.circles.find((x) => x.space === space)
    const mine = c && c.mine
    if (mine && mine.client === hex(this.client.publicKey) && mine.on === this.on && !mine.left) return
    await space._put('hg/holder', { client: this.client.publicKey, on: this.on, left: false })
  }

  // Leaving a circle (lib/index.js leaveSpace): this person's devices drop it,
  // holders delete what it handed. Written before the space is left.
  async leaving (space) {
    await space._put('hg/holder', { client: this.client.publicKey, on: false, left: true })
  }

  // --- holding ---

  async #serve (covered) {
    const hg = this.hg
    const swarm = hg._network.swarm
    if (!swarm) return // update() again once online (lib/network.js)
    if (!this.server) {
      const server = new Holder(path.join(hg.dir, 'holding'), { swarm, store: hg.store, wakeup: hg._network.wakeup, enableGc: false })
      server.on('add-cores-received', (stream, request) => this.#received(stream, request))
      await server.ready()
      if (this.closed) return server.close().catch(safetyCatch)
      this.server = server
      await swarm.listen()
      for (const { space } of this.info.values()) this.#join(space)
      this.fitTimer = setInterval(() => this.#fit().catch(safetyCatch), FIT_MS)
      if (this.fitTimer.unref) this.fitTimer.unref()
    }
    this.server.trustedPubKeys.clear()
    for (const k of this.trusted.keys()) this.server.addTrustedPubKey(b4a.from(k, 'hex'))
    for (const k of uncovered(this.held, covered)) await this.#drop(k)
    this.#saveLater()
  }

  async #stopServing () {
    if (!this.server && !this.held.size) return
    for (const k of [...this.held.keys()]) {
      this.held.delete(k)
      await this.#drop(k)
    }
    clearInterval(this.fitTimer)
    this.fitTimer = null
    const server = this.server
    this.server = null
    if (server) await server.close().catch(safetyCatch)
    this.#saveLater()
  }

  #received (stream, request) {
    const who = this.trusted.get(hex(stream.remotePublicKey))
    if (!who || !request.referrer || this.closed) return
    const space = hex(request.referrer)
    if (this.hg._spaces.has(space)) return // a space of this person's: held as theirs
    const at = Date.now()
    for (const { key, length } of request.cores) {
      const k = hex(key)
      if (!this.held.has(k)) this.held.set(k, new Set())
      this.held.get(k).add(who)
      this.info.set(k, { space, at, priority: request.priority || 0 })
      if (length) this.fetching.set(k, Math.max(length, this.fetching.get(k) || 0))
    }
    this.#join(space)
    this.#saveLater()
    this.#fetch()
  }

  // Downloads what was handed, up to the length the member sent, through a
  // session of its own: blind-peer's own range never starts for a core
  // already open here when it is handed (seen in test/next/net/circles.js).
  async #fetch () {
    if (this.fetchRunning) return
    this.fetchRunning = true
    try {
      while (this.fetching.size && !this.closed && this.server) {
        const [k, length] = this.fetching.entries().next().value
        this.fetching.delete(k)
        if (!this.held.has(k)) continue
        const core = this.hg.store.get({ key: b4a.from(k, 'hex') })
        try {
          await core.ready()
          if (core.contiguousLength >= length) continue
          const range = core.download({ start: 0, end: length })
          let timer = null
          await Promise.race([range.done(), new Promise((resolve) => { timer = setTimeout(resolve, FETCH_MS) })]).catch(safetyCatch)
          clearTimeout(timer)
          range.destroy()
        } finally {
          await core.close().catch(safetyCatch)
        }
      }
    } finally {
      this.fetchRunning = false
    }
  }

  // Joins a held space's topic: anyone in it finds this device (FR-007).
  // shortcut: one DHT announce per held space, outside the topic queue (spec
  // 015); rank them after this person's own once a holder holds hundreds.
  #join (space) {
    const swarm = this.hg._network.swarm
    if (!swarm || !this.server || this.topics.has(space) || this.hg._spaces.has(space)) return
    this.topics.set(space, swarm.join(crypto.discoveryKey(b4a.from(space, 'hex')), { server: true, client: false }))
  }

  // Deletes a held core (forgotten already in `held`): its record, its blocks,
  // and the space's topic once nothing of it is held. A space this person
  // holds as theirs keeps its blocks.
  async #drop (k) {
    const info = this.info.get(k)
    this.info.delete(k)
    const key = b4a.from(k, 'hex')
    const server = this.server
    if (server) {
      const tracker = server.activeReplication.get(hex(crypto.discoveryKey(key)))
      if (tracker) await tracker.core.close().catch(safetyCatch)
      if (await server.db.getCoreRecord(key)) server.db.deleteCore(key)
      await server.flush()
    }
    if (info && !this.hg._spaces.has(info.space)) {
      const core = this.hg.store.get({ key })
      await core.ready().then(() => core.length && core.clear(0, core.length)).catch(safetyCatch)
      await core.close().catch(safetyCatch)
    }
    if (info && ![...this.info.values()].some((i) => i.space === info.space)) {
      const d = this.topics.get(info.space)
      this.topics.delete(info.space)
      if (d) await Promise.resolve(d.destroy()).catch(safetyCatch)
    }
  }

  // Past the share: whole spaces go, public before private, the oldest
  // handed first (a space is handed again when it grows: its activity).
  async #fit () {
    const server = this.server
    if (!server || this.closed || this.fitting) return
    this.fitting = true
    try {
      await server.flush()
      if (this.used() <= this.bytes) return
      const spaces = new Map() // space hex -> { at, priority, cores }
      for (const [k, i] of this.info) {
        const s = spaces.get(i.space) || { at: 0, priority: 0, cores: [] }
        s.at = Math.max(s.at, i.at)
        s.priority = Math.max(s.priority, i.priority)
        s.cores.push(k)
        spaces.set(i.space, s)
      }
      const order = [...spaces.values()].sort((a, b) => a.priority - b.priority || a.at - b.at)
      for (const s of order) {
        if (this.used() <= this.bytes || this.closed) break
        for (const k of s.cores) {
          this.held.delete(k)
          await this.#drop(k)
        }
      }
      this.#saveLater()
    } finally {
      this.fitting = false
    }
  }

  // --- handing ---

  async #handTo (holders) {
    const network = this.hg._network
    const dht = network.swarm && network.swarm.dht
    if (!dht) return
    const sig = holders.join()
    if (sig !== this.keys) {
      this.keys = sig
      if (this.peering) await this.peering.close().catch(safetyCatch)
      this.peering = null
      if (holders.length) {
        this.peering = new BlindPeering(dht, this.hg.store, { keys: holders.map((k) => b4a.from(k, 'hex')), wakeup: network.wakeup, pick: holders.length })
        this.peering.keyPair = this.client // the key holders trust, not the swarm's (one connection per key)
      }
    }
    this.holders = holders
    if (!this.peering) return
    const items = []
    for (const s of [...this.hg._spaces.values()]) {
      if (s.personal || this.closed) continue
      const saved = await this.#coresOf(s).catch(() => null)
      if (saved) items.push({ space: s, private: saved.private, activity: s._used || 0, bytes: saved.cores.reduce((n, c) => n + c[2], 0), cores: saved.cores })
    }
    const { hand } = plan(items, this.memberBytes)
    this.handList = hand.flatMap((i) => i.cores.map(([key, length]) => ({ key, length })))
    // the oldest first in each group: the newest are the last handed, so a
    // holder past its share drops the oldest (#fit)
    hand.sort((a, b) => (b.private ? 1 : 0) - (a.private ? 1 : 0) || a.activity - b.activity)
    for (const item of hand) {
      if (this.closed || !this.peering) return
      await this.#handSpace(item).catch(safetyCatch)
    }
  }

  // A space's cores, [[key hex, length held here, bytes]], and whether it is private:
  // from the space if open (and saved), else as saved; a space never seen
  // open since is opened once for it.
  async #coresOf (space) {
    if (!space.opened && !space.closed) {
      const saved = await this.hg._meta('cores:' + space.hex)
      if (saved) return saved
      await space._ready()
    }
    if (!space.opened || space.closed) return null
    return this.remember(space)
  }

  // Saves the list of an open space's cores (also as it closes when idle,
  // lib/index.js _closeIdle): handing it later needs it not open.
  async remember (space) {
    const keys = await coreKeys(space)
    const cores = []
    for (const key of keys) {
      const core = this.hg.store.get({ key })
      await core.ready()
      cores.push([hex(key), core.contiguousLength, core.byteLength]) // what this device has to hand
      await core.close()
    }
    const out = { private: space.private, cores }
    const sig = JSON.stringify(out)
    if (this.saved.get(space.hex) !== sig) {
      this.saved.set(space.hex, sig)
      await this.hg._setMeta('cores:' + space.hex, out)
    }
    return out
  }

  async #handSpace (item) {
    const holders = this.holders
    const keptAll = (key, length) => holders.every((h) => ((this.kept.get(h) || new Map()).get(key) || 0) >= length)
    const pending = item.cores.filter(([key, length]) => length > 0 && !keptAll(key, length))
    if (!pending.length) return
    const peering = this.peering
    const sessions = []
    try {
      for (const [key] of pending) {
        const core = this.hg.store.get({ key: b4a.from(key, 'hex') })
        await core.ready()
        sessions.push(core)
      }
      const opts = { referrer: item.space.keyBytes, priority: item.private ? 1 : 0, announce: false }
      let timer = null
      const late = new Promise((resolve) => { timer = setTimeout(resolve, HAND_MS) })
      await Promise.race([Promise.all(sessions.map((core) => peering.addCore(core, opts))), late])
      clearTimeout(timer)
      // until each holder has it all (or HAND_MS): what "kept by" counts
      const deadline = Date.now() + HAND_MS
      for (;;) {
        let done = true
        for (const core of sessions) {
          for (const h of holders) {
            const peer = core.peers.find((p) => hex(p.remotePublicKey) === h)
            if (!peer) { done = false; continue }
            const map = this.kept.get(h) || new Map()
            this.kept.set(h, map)
            const k = hex(core.key)
            if (peer.remoteContiguousLength > (map.get(k) || 0)) map.set(k, peer.remoteContiguousLength)
            if ((map.get(k) || 0) < core.contiguousLength) done = false
          }
        }
        if (done || Date.now() > deadline || this.closed || this.peering !== peering) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    } finally {
      for (const core of sessions) await core.close().catch(safetyCatch)
      this.#saveLater()
    }
  }

  // --- what apps show ---

  // { members, holders, keptBy } of a circle (FR-011, space.status()): its
  // members, how many have a device holding, how many of the others hold all
  // this device hands. As of the last update; 'status' tells when it changes.
  statusOf (space) {
    const me = hex(this.hg._identity.publicKey)
    const c = this.circles.find((x) => x.space === space)
    if (!c) return { members: space.state.members.size, holders: 0, keptBy: 0 }
    const holding = new Set(c.records.filter((r) => r.on).map((r) => r.identity))
    if (this.on) holding.add(me)
    const keeps = (device) => this.handList.every(({ key, length }) => ((this.kept.get(device) || new Map()).get(key) || 0) >= length)
    const keptBy = new Set(c.records.filter((r) => r.on && r.identity !== me && keeps(r.device)).map((r) => r.identity))
    return { members: c.members.size, holders: holding.size, keptBy: keptBy.size }
  }

  // --- saving ---

  #saveLater () {
    if (this.saveTimer || this.closed) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.#save().catch(safetyCatch)
    }, 1000)
    if (this.saveTimer.unref) this.saveTimer.unref()
  }

  async #save () {
    const held = {}
    for (const [k, by] of this.held) held[k] = { ...this.info.get(k), by: [...by] }
    const kept = {}
    for (const [h, m] of this.kept) kept[h] = Object.fromEntries(m)
    await this.hg._setMeta('held', held)
    await this.hg._setMeta('kept', kept)
  }

  async close () {
    if (this.closed) return
    clearTimeout(this.timer)
    if (this.running) await this.running
    this.closed = true
    clearTimeout(this.saveTimer)
    clearInterval(this.fitTimer)
    if (this.saveTimer) await this.#save().catch(safetyCatch)
    this.saveTimer = null
    if (this.peering) await this.peering.close().catch(safetyCatch)
    for (const d of this.topics.values()) await Promise.resolve(d.destroy()).catch(safetyCatch)
    this.topics.clear()
    if (this.server) await this.server.close().catch(safetyCatch)
    this.server = null
  }
}

// Every core of an open space: its decision log's (writers, views) and its logs.
async function coreKeys (space) {
  const keys = new Map()
  const add = (k) => { if (k) keys.set(hex(k), k) }
  const base = space.decisionLog.base
  add(base.key)
  add(base.local.key)
  for await (const { key } of base.system.list()) add(key)
  for (const v of base.views()) add(v.key)
  add(space.own.key)
  add(space._idcore.key)
  for (const log of space.directory.logs.values()) add(log.key)
  return [...keys.values()]
}

module.exports = { Holding, coreKeys }
