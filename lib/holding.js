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
// per-member cap: spec's shortcut), each to its own holders only (spec 024:
// 5 in all, lib/circles.js holdersOf), through one blind-peering client
// given that space's holders as `keys` (research R1), again when it grew. A
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
const cenc = require('compact-encoding')
const ProtomuxRPC = require('protomux-rpc')
const { plan, uncovered, holdersOf, extraFor, rarest, unseen, markHour, onlineShare, packHours, unpackHours, COPIES, MEMBER_BYTES, SHARE_BYTES } = require('./circles.js')

const hex = (b) => b4a.toString(b, 'hex')
const HAND_MS = 10000 // a hand-off not acknowledged within this is tried again at the next change
const FIT_MS = 2000 // how often a holder checks it fits its share
const FETCH_MS = 30000 // a hand-off not downloaded within this waits for the next one
const LEAVE_MS = 10000 // leaving waits this long, at most, for a peer to get the `left` record
const RECORDS = 1000 // hg/holder records read per circle, newest first
const DAY_MS = 24 * 3600 * 1000 // a holding device reports its online share at most this often (FR-008)
const SEEN_SAVE_MS = 5 * 60 * 1000 // seen times and online hours are saved at most this often
const TICK_MS = 5 * 60 * 1000 // how often the copies are checked with nothing else changing (holders going stale)

// A blind peer that takes cores from trusted clients only (circle members).
class Holder extends BlindPeer {
  async _onaddcores (stream, request) {
    if (!this._isTrustedPeer(stream.remotePublicKey)) throw new Error('Not a member of a circle held here')
    if (this.onhand) await this.onhand(stream, request) // recorded (or refused as this instance's own) first
    return super._onaddcores(stream, request)
  }

  async _onaddcore (stream, record) {
    if (!this._isTrustedPeer(stream.remotePublicKey)) throw new Error('Not a member of a circle held here')
    return super._onaddcore(stream, record)
  }

  // ours, not blind-peer's: blind-peer's lets any trusted member delete any core it has a record of
  async _ondeletecore (stream, { key }) {
    return this.ondelete ? this.ondelete(stream.remotePublicKey, key) : false
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
    this.leavingNow = new Set() // circles (hex) this device is leaving
    this.peering = null
    this.holders = new Set() // device keys hex: every device holding in this person's circles
    this.kept = new Map() // holder device hex -> Map core hex -> length it acknowledged
    this.extra = new Map() // space hex -> the device keeping its extra copy (FR-005)
    this.seen = new Map() // holder device hex -> when this device last saw it online (FR-006)
    this.replaced = new Set() // holder devices hex replaced after 7 days unseen (FR-006)
    this.hours = new Map() // device hex (holders, this one) -> Set of the hours it was online, last 30 days (FR-007)
    this.reported = 0 // when this device last wrote its online share (FR-008)
    this.seenSaved = 0
    this.deviceOf = new Map() // device hex -> identity hex, of this person's circles' devices
    this.rpcs = new WeakMap() // connection -> ProtomuxRPC (askDelete)
    this.now = () => Date.now() // lib/testing.js holdingClock moves it
    this.copiesSig = '' // the copies of every space handed, as last told ('copies' event)
    this.handed = new Map() // space hex -> { targets: [device hex], cores: [[key hex, length, bytes]] }, as of the last pass
    this.saved = new Map() // space hex -> signature of its saved core list
    this.running = null
    this.again = false
    this.timer = null
    this.fitTimer = null
    this.tick = null
    this.retry = null
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
    const seen = (await hg._meta('seen')) || {}
    for (const [d, at] of Object.entries(seen.at || {})) this.seen.set(d, at)
    for (const d of seen.replaced || []) this.replaced.add(d)
    for (const [d, packed] of Object.entries(seen.hours || {})) this.hours.set(d, unpackHours(packed))
    this.reported = seen.reported || 0
    this.tick = setInterval(() => { if (this.active) this.update() }, TICK_MS)
    if (this.tick.unref) this.tick.unref()
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
    const deviceOf = new Map()
    const covered = new Set()
    for (const c of this.circles) {
      c.devices = [] // its other people's holding devices, for holdersOf
      for (const r of c.records) {
        if (r.identity === me) continue
        deviceOf.set(r.device, r.identity)
        if (r.on) {
          holders.add(r.device)
          c.devices.push({ device: r.device, identity: r.identity })
        }
        trusted.set(r.client, r.identity)
      }
      for (const m of c.members) if (m !== me) covered.add(m)
    }
    this.trusted = trusted
    this.deviceOf = deviceOf
    this.holders = holders
    if (this.on) await this.#serve(covered)
    else await this.#stopServing()
    this.#statusChanged()
    await this.#handTo()
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
      const cut = new Set() // identities past their newest `left`: their older device records are from before it
      for (const r of items) {
        const identity = hex(z32.decode(r.author))
        if (!left.has(identity)) left.set(identity, !!r.left)
        if (cut.has(identity)) continue
        if (r.left) cut.add(identity)
        const device = hex(z32.decode(r.device))
        if (!byDevice.has(device) && b4a.isBuffer(r.client) && r.client.byteLength === 32) byDevice.set(device, { identity, device, client: hex(r.client), on: !!r.on, left: !!r.left, online: r.online || 0 })
      }
      const members = new Set([...s.state.members.keys()].filter((id) => !left.get(id)))
      if (left.get(me) && !this.leavingNow.has(s.hex)) { // left from another device: this one leaves too (FR-009)
        this.leavingNow.add(s.hex)
        this.hg.leaveSpace(s.key).catch(safetyCatch)
      }
      if (!members.has(me)) continue
      out.push({ space: s, members, records: [...byDevice.values()].filter((r) => members.has(r.identity)), mine: byDevice.get(hex(this.hg._identity.device.publicKey)) || null })
    }
    return out
  }

  // This device's record in a circle: its client key, whether it holds, and
  // (holding) its online share, rewritten for it at most once a day.
  async #writeOwn (space) {
    const c = this.circles.find((x) => x.space === space)
    const mine = c && c.mine
    const own = this.hours.get(hex(this.hg._identity.device.publicKey))
    const online = this.on && own ? onlineShare(own, this.now()) : 0
    // shortcut: only a move of 5 points or more, so records stay few (023 reads the newest RECORDS); an index by device if circles need finer
    const report = this.on && (!mine || Math.abs((mine.online || 0) - online) >= 5) && this.now() - this.reported >= DAY_MS
    if (mine && mine.client === hex(this.client.publicKey) && mine.on === this.on && !mine.left && !report) return
    await space._put('hg/holder', { client: this.client.publicKey, on: this.on, left: false, online: report ? online : (mine ? mine.online : 0) })
    if (report) {
      this.reported = this.now()
      this.#saveLater()
    }
  }

  // Leaving a circle (lib/index.js leaveSpace): this person's devices drop it,
  // holders delete what it handed. Written before the space is left; this
  // device waits up to LEAVE_MS for one peer to have it.
  // shortcut: nobody online then, holders keep this person's data until the
  // record reaches them (through any of them holding the circle); a self-leave
  // decision would fix it if forums ever need real leaving too.
  async leaving (space) {
    if (this.leavingNow.has(space.hex)) return // left from another device: written there
    this.leavingNow.add(space.hex)
    await space._put('hg/holder', { client: this.client.publicKey, on: false, left: true })
    const core = space.own.core
    const length = core.length
    const deadline = Date.now() + LEAVE_MS
    while (Date.now() < deadline && !core.peers.some((p) => p.remoteContiguousLength >= length) && !this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }

  // Joined a circle (again): a later record than any `left` this person wrote.
  async joined (space) {
    this.leavingNow.delete(space.hex)
    await space._put('hg/holder', { client: this.client.publicKey, on: this.on, left: false })
    await this.update()
  }

  // --- holding ---

  async #serve (covered) {
    const hg = this.hg
    const swarm = hg._network.swarm
    if (!swarm) return // update() again once online (lib/network.js)
    if (!this.server) {
      const server = new Holder(path.join(hg.dir, 'holding'), { swarm, store: hg.store, wakeup: hg._network.wakeup, enableGc: false })
      server.onhand = (stream, request) => this.#received(stream, request).catch(safetyCatch)
      server.ondelete = (remote, key) => this.#deleted(remote, key)
      await server.ready()
      await this.#saveAll() // #ownCores knows every core of this person's spaces before taking any
      if (this.closed) return server.close().catch(safetyCatch)
      this.server = server
      await swarm.listen()
      for (const conn of swarm.connections) server._onconnection(conn) // opened before it: delete-core answered there too
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

  // A member's hand-off. Checked by core key, not by the referrer it names: a
  // core of this instance's own spaces is never recorded as held (so never
  // cleared when dropped).
  async #received (stream, request) {
    const who = this.trusted.get(hex(stream.remotePublicKey))
    if (!who || !request.referrer || this.closed) return
    const space = hex(request.referrer)
    if (this.hg._spaces.has(space)) return // a space of this person's: held as theirs
    const own = await this.#ownCores()
    const at = Date.now()
    for (const { key, length } of request.cores) {
      const k = hex(key)
      if (own.has(k)) continue
      if (!this.held.has(k)) this.held.set(k, new Set())
      this.held.get(k).add(who)
      this.info.set(k, { space, at, priority: request.priority || 0 })
      if (length) this.fetching.set(k, Math.max(length, this.fetching.get(k) || 0))
    }
    this.#join(space)
    this.#saveLater()
    this.#fetch()
  }

  // Saves the core list of each closed space of this person's that has none
  // (closed before this device was in a circle): opened once for it.
  async #saveAll () {
    for (const s of [...this.hg._spaces.values()]) {
      if (this.closed) return
      if (s.opened || s.closed || await this.hg._meta('cores:' + s.hex)) continue
      await s._ready().catch(safetyCatch)
      if (s.opened && !s.closed) await this.remember(s).catch(safetyCatch)
    }
  }

  // Every core of this instance's own spaces (hex): the personal space and
  // open ones from the spaces, closed ones from their saved lists and every
  // log accepted in them (lib/instance.js), whatever a hand-off says.
  async #ownCores () {
    const out = new Set()
    for (const logs of this.hg._logs.values()) for (const k of logs) out.add(k)
    for (const s of [...this.hg._spaces.values()]) {
      out.add(s.hex)
      if (s.opened && !s.closed) {
        for (const key of await coreKeys(s).catch(() => [])) out.add(hex(key))
      } else {
        const saved = await this.hg._meta('cores:' + s.hex)
        if (saved) for (const [k] of saved.cores) out.add(k)
      }
    }
    return out
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
    if (info && !this.hg._spaces.has(info.space) && !(await this.#ownCores()).has(k)) {
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

  async #handTo () {
    const network = this.hg._network
    const dht = network.swarm && network.swarm.dht
    if (!dht) return
    for (const h of this.kept.keys()) if (!this.holders.has(h)) this.kept.delete(h) // gone: it deleted what it held
    // a circle with nobody holding keeps nothing: the split is over the others
    const view = this.circles.filter((c) => c.devices.length).map((c) => ({ key: c.space.hex, devices: c.devices }))
    if (!view.length) { // nobody to hand to: no space listed (closed ones would open for it)
      this.#stale() // this device's own online hours still counted
      this.handed = new Map()
      this.extra = new Map()
      return this.#copiesChanged()
    }
    if (!this.peering) {
      this.peering = new BlindPeering(dht, this.hg.store, { wakeup: network.wakeup })
      this.peering.keyPair = this.client // the key holders trust, not the swarm's (one connection per key)
    }
    const items = []
    for (const s of [...this.hg._spaces.values()]) {
      if (s.personal || this.closed) continue
      const saved = await this.#coresOf(s).catch(() => null)
      if (saved) items.push({ space: s, private: saved.private, activity: s._used || 0, bytes: saved.cores.reduce((n, c) => n + c[2], 0), cores: saved.cores })
    }
    const { hand } = plan(items, this.memberBytes)
    const stale = this.#stale()
    const online = (d) => this.#online(d)
    const handed = new Map()
    const extra = new Map()
    for (const item of hand) {
      const space = item.space.hex
      const regular = holdersOf(space, view, stale)
      const people = new Set(regular.map((d) => this.deviceOf.get(d)))
      const candidates = holdersOf(space, view.map((x) => ({ key: x.key, devices: x.devices.filter((d) => !people.has(d.identity)) })), stale) // the next ranked
      const more = extraFor({ prev: this.extra.get(space) || null, regular, candidates, online })
      if (more) extra.set(space, more)
      item.targets = more ? [...regular, more] : regular
      item.online = item.targets.filter((d) => online(d) && this.#keeps(d, item.cores)).length
      handed.set(space, { regular, targets: item.targets, cores: item.cores })
    }
    this.handed = handed
    this.extra = extra
    // the oldest first in each group: the newest are the last handed, so a
    // holder past its share drops the oldest (#fit); the rarest before all (FR-004)
    hand.sort((a, b) => (b.private ? 1 : 0) - (a.private ? 1 : 0) || a.activity - b.activity)
    for (const item of rarest(hand)) {
      if (this.closed) return
      if (item.targets.some(online)) await this.#handSpace(item).catch(safetyCatch)
    }
    await this.#deletes().catch(safetyCatch)
    this.#copiesChanged()
  }

  #copiesChanged () {
    const sig = JSON.stringify([...this.handed.keys()].map((k) => [k, this.copiesOf({ hex: k })]))
    if (sig !== this.copiesSig) {
      this.copiesSig = sig
      this.hg.emit('copies')
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

  // To its online holders only: the others get it when seen (a connection runs update()).
  async #handSpace (item) {
    const holders = item.targets.filter((d) => this.#online(d))
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
        for (const h of holders) { // handed: told to delete if it stops being a holder (#deletes)
          if (!this.kept.has(h)) this.kept.set(h, new Map())
          if (!this.kept.get(h).has(key)) this.kept.get(h).set(key, 0)
        }
      }
      const opts = { referrer: item.space.keyBytes, priority: item.private ? 1 : 0, announce: false, keys: holders.map((h) => b4a.from(h, 'hex')), pick: holders.length }
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
        if (done || Date.now() > deadline || this.closed) break
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
    } finally {
      for (const core of sessions) await core.close().catch(safetyCatch)
      this.#saveLater()
    }
  }

  // Holders handed a core of a space they no longer hold (pushed out by the
  // ranking, an extra copy no longer needed, replaced after 7 days unseen):
  // told to delete it once online, and once the space's regular holders have
  // it all. Only spaces still handed: one left or past the cap stays held
  // until the holder's share drops it (spec 023's shortcut).
  async #deletes () {
    for (const [h, map] of this.kept) {
      if (this.closed || !this.#online(h)) continue
      for (const k of [...map.keys()]) {
        const space = [...this.handed.values()].find((x) => x.cores.some(([key]) => key === k))
        if (!space || space.targets.includes(h) || !space.regular.every((d) => this.#keeps(d, space.cores))) continue
        const done = await this.askDelete(h, b4a.from(k, 'hex'))
        if (done === null) { // no answer (its holding not started yet?): the rest for this holder soon
          this.#retryLater()
          break
        }
        map.delete(k) // false too: it doesn't hold it for this person
      }
    }
    this.#saveLater()
  }

  // Blind-peer's `delete-core` to a holder, over this instance's connection
  // to its device: true deleted, false refused, null not answered.
  async askDelete (device, key) {
    const conn = [...this.hg._network.connections].find((x) => hex(x.remotePublicKey) === device)
    if (!conn) return null
    try {
      return await this.#rpc(conn).request('delete-core', key, { requestEncoding: cenc.fixed32, responseEncoding: cenc.bool, timeout: HAND_MS })
    } catch (err) {
      safetyCatch(err)
      return null
    }
  }

  // A connection (lib/network.js): Protomux turns down a channel the other
  // side opens before this side has one, so a holder's delete-core channel
  // (blind-peer opens it on every connection) is answered as it opens.
  attach (conn, mux) {
    mux.pair({ protocol: 'protomux-rpc', id: conn.remotePublicKey }, () => {
      this.#rpc(conn)
      this.changed() // a holder's holding started: what it should delete can be asked now
    })
  }

  #retryLater () {
    if (this.retry || this.closed) return
    this.retry = setTimeout(() => {
      this.retry = null
      this.update()
    }, HAND_MS)
    if (this.retry.unref) this.retry.unref()
  }

  #rpc (conn) {
    let rpc = this.rpcs.get(conn)
    if (!rpc || rpc.closed) {
      rpc = new ProtomuxRPC(conn, { id: conn.remotePublicKey, valueEncoding: cenc.none })
      this.rpcs.set(conn, rpc)
    }
    return rpc
  }

  // Holders replaced after 7 days unseen (FR-006, lib/circles.js unseen: and
  // this device online 24 hours since), as this device saw them (each seen
  // when online, or when first known): for good, so seen again they don't
  // push their replacements out; ranked after everyone else (a regular
  // holder again only when needed).
  #stale () {
    const now = this.now()
    for (const d of this.holders) if (this.#online(d) || !this.seen.has(d)) this.seen.set(d, now)
    for (const d of this.seen.keys()) if (!this.holders.has(d)) this.seen.delete(d) // deleted with the circle
    for (const d of this.replaced) if (!this.holders.has(d)) this.replaced.delete(d)
    const self = hex(this.hg._identity.device.publicKey)
    for (const d of this.hours.keys()) if (d !== self && !this.holders.has(d)) this.hours.delete(d)
    for (const d of [self, ...this.holders]) {
      if (d !== self && !this.#online(d)) continue
      if (!this.hours.has(d)) this.hours.set(d, new Set())
      markHour(this.hours.get(d), now)
    }
    for (const [d, at] of this.seen) if (unseen(at, this.hours.get(self), now)) this.replaced.add(d)
    if (Date.now() - this.seenSaved >= SEEN_SAVE_MS) this.#saveLater()
    return this.replaced
  }

  // A holder asks to delete a core (blind-peer's delete-core): only the
  // member who handed it, and only their part (another member handing the
  // same core keeps it held). Never this instance's own cores: they are
  // never in `held`, and #drop checks again.
  async #deleted (remote, key) {
    const who = this.trusted.get(hex(remote)) || this.deviceOf.get(hex(remote))
    const k = hex(key)
    const by = this.held.get(k)
    if (!who || !by || !by.has(who) || this.closed) return false
    by.delete(who)
    if (!by.size) {
      this.held.delete(k)
      await this.#drop(k)
    }
    this.#saveLater()
    return true
  }

  // --- what apps show ---

  // { members, holders } of a circle (FR-011, space.status()): its members,
  // how many have a device holding. As of the last update; 'status' tells when it changes.
  statusOf (space) {
    const me = hex(this.hg._identity.publicKey)
    const c = this.circles.find((x) => x.space === space)
    if (!c) return { members: space.state.members.size, holders: 0 }
    const holding = new Set(c.records.filter((r) => r.on).map((r) => r.identity))
    if (this.on) holding.add(me)
    return { members: c.members.size, holders: holding.size }
  }

  // { wanted, kept, online } of a space of this person's (spec 024 FR-009):
  // the copies wanted (0 when it isn't handed: no circle holding, or past the
  // member cap), its holders with all of its latest data (as they
  // acknowledged it to this device), how many of those are online now.
  copiesOf (space) {
    const h = this.handed.get(space.hex)
    if (!h || !h.targets.length) return { wanted: 0, kept: 0, online: 0 }
    const kept = h.targets.filter((d) => this.#keeps(d, h.cores))
    return { wanted: Math.max(COPIES, this.circles.filter((c) => c.devices.length).length), kept: kept.length, online: kept.filter((d) => this.#online(d)).length }
  }

  #keeps (device, cores) {
    const map = this.kept.get(device)
    return !!map && cores.every(([key, length]) => (map.get(key) || 0) >= length)
  }

  // A holder is online when this instance has a connection to its device (its swarm key).
  #online (device) {
    for (const conn of this.hg._network.connections) if (hex(conn.remotePublicKey) === device) return true
    return false
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
    if (this.closed || Date.now() - this.seenSaved >= SEEN_SAVE_MS) {
      this.seenSaved = Date.now()
      const hours = Object.fromEntries([...this.hours].map(([d, h]) => [d, packHours(h, this.now())]))
      await this.hg._setMeta('seen', { at: Object.fromEntries(this.seen), replaced: [...this.replaced], hours, reported: this.reported })
    }
  }

  async close () {
    if (this.closed) return
    clearTimeout(this.timer)
    if (this.running) await this.running
    this.closed = true
    clearTimeout(this.saveTimer)
    clearInterval(this.fitTimer)
    clearInterval(this.tick)
    clearTimeout(this.retry)
    if (this.saveTimer || this.seen.size) await this.#save().catch(safetyCatch) // seen times and hours are saved at most every SEEN_SAVE_MS otherwise
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
  add(space.own && space.own.key)
  add(space._idcore && space._idcore.key)
  if (space.directory) for (const log of space.directory.logs.values()) add(log.key)
  return [...keys.values()]
}

module.exports = { Holding, coreKeys }
