// Networking (research R17): one Hyperswarm per instance, one topic per space
// (its discovery key). Each connection replicates the Corestore and opens the
// space channel of every space this instance holds. Members that come online
// at the same moment usually miss each other's first lookup: each topic looks
// again after a short, random, doubling wait until a member is found (v1's
// re-look, src/networking.js).
//
// Spec 015 (research.md R1): a DHT node sends at most 80 requests per 750 ms
// and queues the rest until the next slot, so joining many topics at once
// delays every one of them, the space being visited included. Topics go
// through one queue: one background join at a time, a space in use at once;
// at most `maxAnnounced` announced (own, pinned, recent first), the others
// only look for peers; a closed space's topic is kept for a grace period.

const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const ProtomuxWakeup = require('protomux-wakeup')
const b4a = require('b4a')
const z32 = require('z32')
const safetyCatch = require('safety-catch')
const { PROTOCOL } = require('./directory.js')

const RELOOK_MS = [1000, 2000, 4000, 8000, 16000, 32000]
const SILENT_MS = 5000 // a connection the other side sends nothing on is dead (A16)
const REDIAL_MS = 2000 // the side Hyperswarm doesn't expect to dial waits up to twice this
const GRACE_MS = 5 * 60 * 1000 // a closed space's topic is kept this long (it may be visited again)

class Network {
  // hg: store, _spaces (Map), emit('connection'). `swarm`: tests only.
  constructor (hg, { bootstrap, keyPair = null, maxAnnounced = 32, graceMs = GRACE_MS, swarm = null } = {}) {
    this.hg = hg
    this.bootstrap = bootstrap
    this.keyPair = keyPair
    this.maxAnnounced = maxAnnounced
    this.graceMs = graceMs
    this._swarm = swarm
    this.swarm = null
    this.wakeup = new ProtomuxWakeup()
    this.connections = new Set()
    this.topics = new Map() // space hex -> discovery (a session of Hyperswarm's)
    this.announced = new Set() // space hex: topics this device announces (at most maxAnnounced)
    this.queue = [] // background joins waiting: { space, seq, resolve, done }
    this.running = false
    this.paused = false
    this.leaving = new Map() // space hex -> grace timer
    this.relooking = new Set() // space hex
    this.seq = 0
    this.timers = new Set()
    this.redialing = new Set() // device hex: peers dialed again after a dead connection
    this.closed = false
  }

  get connected () { return !!this.swarm }

  async connect () {
    if (this.swarm || this.closed) return
    this.swarm = this._swarm || new Hyperswarm({ ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}), ...(this.keyPair ? { keyPair: this.keyPair } : {}) })
    this.swarm.on('connection', (conn) => this.#onConnection(conn))
    const open = [...this.hg._spaces.values()].filter((space) => space.opened)
    for (const space of open) if (space._helpers) space._helpers.update() // spec 013: needs the DHT
    await Promise.all(open.map((space) => this.join(space)))
  }

  // Starts finding the members of a space (now, or at connect()): `now` for
  // a space in use (past the queue), else after the joins queued before it.
  // Resolves once its topic is flushed.
  join (space, { now = false } = {}) {
    const h = space.hex
    const grace = this.leaving.get(h)
    if (grace) {
      clearTimeout(grace)
      this.timers.delete(grace)
      this.leaving.delete(h)
    }
    if (!this.swarm || this.closed) return Promise.resolve()
    if (this.topics.has(h)) {
      if (now) this.used(space)
      return Promise.resolve()
    }
    const queued = this.queue.find((job) => job.space === space)
    if (queued && !now) return queued.done
    if (queued) this.queue.splice(this.queue.indexOf(queued), 1)
    if (now) {
      const done = this.#start(space, true)
      if (queued) done.then(queued.resolve, queued.resolve)
      return done
    }
    const job = { space, seq: this.seq++, resolve: null, done: null }
    job.done = new Promise((resolve) => { job.resolve = resolve })
    this.queue.push(job)
    this.#next()
    return job.done
  }

  async #start (space, now) {
    for (const conn of this.connections) space.directory.attach(conn.userData, conn.remotePublicKey)
    const server = this.#announce(space)
    const discovery = this.swarm.join(space.discoveryKey, { server, client: true })
    this.topics.set(space.hex, discovery)
    if (now || server) this.#relook(space, discovery, 0)
    await discovery.flushed().catch(safetyCatch)
  }

  // The next background join, once none is running: the best ranked, then
  // the most recently used, then the oldest.
  #next () {
    if (this.running || this.closed || this.paused || !this.queue.length) return
    let best = 0
    for (let i = 1; i < this.queue.length; i++) if (order(this.queue[i], this.queue[best]) < 0) best = i
    const [job] = this.queue.splice(best, 1)
    this.running = true
    const run = this.topics.has(job.space.hex) || job.space.closed ? Promise.resolve() : this.#start(job.space, false)
    run.catch(safetyCatch).then(() => {
      this.running = false
      job.resolve()
      this.#next()
    })
  }

  // Should this device announce `space`? Yes while there is room; else in
  // place of an announced one ranked below it, which then only looks.
  #announce (space) {
    if (this.announced.size < this.maxAnnounced) {
      this.announced.add(space.hex)
      return true
    }
    let worst = null
    for (const h of this.announced) {
      const s = this.hg._spaces.get(h)
      if (s && (!worst || below(s, worst))) worst = s
    }
    if (!worst || !below(worst, space)) return false
    this.announced.delete(worst.hex)
    const d = this.topics.get(worst.hex)
    if (d) d.refresh({ server: false, client: true }).catch(safetyCatch)
    this.announced.add(space.hex)
    return true
  }

  // A space in use (a call, a live view): a topic that found nobody looks
  // again (research.md R1: re-looks only while in use).
  used (space) {
    const discovery = this.topics.get(space.hex)
    if (!discovery || this.relooking.has(space.hex) || space.directory.peers > 0) return
    this.#relook(space, discovery, 0)
  }

  // Stops finding the members of a space: at once (left, dropped), or after
  // the grace period (closed while idle: it may be visited again soon).
  async leave (space, { grace = false } = {}) {
    const queued = this.queue.find((job) => job.space === space)
    if (queued) {
      this.queue.splice(this.queue.indexOf(queued), 1)
      queued.resolve()
    }
    if (!this.topics.has(space.hex)) return
    if (grace) {
      if (!this.leaving.has(space.hex)) {
        this.leaving.set(space.hex, this.#later(this.graceMs, () => {
          this.leaving.delete(space.hex)
          this.#drop(space.hex).catch(safetyCatch)
        }))
      }
      return
    }
    const timer = this.leaving.get(space.hex)
    if (timer) {
      clearTimeout(timer)
      this.timers.delete(timer)
      this.leaving.delete(space.hex)
    }
    await this.#drop(space.hex)
  }

  async #drop (h) {
    const discovery = this.topics.get(h)
    if (!discovery) return
    this.topics.delete(h)
    this.relooking.delete(h)
    const freed = this.announced.delete(h)
    await discovery.destroy()
    if (!freed || this.closed) return
    // An announce slot freed: the best ranked topic that only looks takes it.
    let best = null
    for (const [other, d] of this.topics) {
      const s = this.hg._spaces.get(other)
      if (!s || this.announced.has(other) || this.leaving.has(other)) continue
      if (!best || below(best.s, s)) best = { s, d }
    }
    if (!best) return
    this.announced.add(best.s.hex)
    await best.d.refresh({ server: true, client: true }).catch(safetyCatch)
  }

  #relook (space, discovery, attempt) {
    if (attempt >= RELOOK_MS.length) {
      this.relooking.delete(space.hex)
      return
    }
    this.relooking.add(space.hex)
    this.#later(RELOOK_MS[attempt] + Math.floor(Math.random() * 500), async () => {
      if (this.closed || discovery.destroyed || space.closed || this.topics.get(space.hex) !== discovery || space.directory.peers > 0) {
        this.relooking.delete(space.hex)
        return
      }
      try { await discovery.refresh() } catch (err) { safetyCatch(err) }
      this.#relook(space, discovery, attempt + 1)
    })
  }

  #later (ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
    return timer
  }

  // Peers on one host or one LAN dialing each other at the same moment:
  // HyperDHT 6.33+ can hand the dialer a connection the other side already
  // destroyed (its LAN shortcut races the holepunch, holepunchto/hyperdht#304),
  // which closes only after ~13 s, and a retry can hit the same race
  // (specs/research/upstream/hyperswarm.md). So a connection nothing arrives
  // on within SILENT_MS is closed, and this peer dialed again: first by the
  // side Hyperswarm expects to dial, by the other a moment later if they are
  // still apart.
  #dead (conn) {
    const key = conn.remotePublicKey
    conn.destroy()
    const first = b4a.compare(this.swarm.keyPair.publicKey, key) > 0
    this.#later(first ? 0 : REDIAL_MS + Math.floor(Math.random() * REDIAL_MS), () => {
      if (this.closed || [...this.connections].some((c) => b4a.equals(c.remotePublicKey, key))) return
      this.redialing.add(b4a.toString(key, 'hex'))
      this.swarm.joinPeer(key)
    })
  }

  #onConnection (conn) {
    conn.on('error', safetyCatch)
    if (this.closed) return conn.destroy()
    this.hg.store.replicate(conn)
    this.wakeup.addStream(conn)
    const mux = conn.userData || Protomux.from(conn)
    this.connections.add(conn)
    const silent = this.#later(SILENT_MS, () => this.#dead(conn))
    conn.once('data', () => {
      clearTimeout(silent)
      this.timers.delete(silent)
    })
    conn.on('close', () => {
      clearTimeout(silent)
      this.timers.delete(silent)
      this.connections.delete(conn)
    })
    const h = b4a.toString(conn.remotePublicKey, 'hex')
    if (this.redialing.delete(h)) this.swarm.leavePeer(conn.remotePublicKey) // linked again: no longer kept dialed
    // Protomux turns down a channel the other side opens before this side
    // has one: open ours then, for any space held here (a space opened on
    // either side after connecting, research.md A7).
    mux.pair({ protocol: PROTOCOL }, (id) => {
      for (const space of this.hg._spaces.values()) {
        if (space.opened && !space.closed && b4a.equals(space.discoveryKey, id)) space.directory.attach(mux, conn.remotePublicKey)
      }
    })
    for (const space of this.hg._spaces.values()) if (space.opened) space.directory.attach(mux, conn.remotePublicKey)
    this.hg.emit('connection', { publicKey: z32.encode(conn.remotePublicKey) })
  }

  async close () {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.leaving.clear()
    for (const job of this.queue.splice(0)) job.resolve()
    this.wakeup.destroy()
    if (!this.swarm) return
    for (const conn of this.connections) conn.destroy()
    const discoveries = [...this.topics.values()]
    await this.swarm.destroy({ force: true }).catch(safetyCatch)
    // force skips each topic's teardown, and with it its refresh timer, which
    // kept test processes alive for minutes (test/brittle/helpers.js).
    await Promise.all(discoveries.map((d) => Promise.resolve(d.destroy()).catch(safetyCatch)))
  }
}

// Seeding rank (lower first): own spaces, pinned, then the others.
function rank (space) {
  return space._own ? 1 : space._pinned ? 2 : 3
}

// Is `a` ranked below `b` for announcing (worse rank, or as good but used
// less recently)?
function below (a, b) {
  return rank(a) > rank(b) || (rank(a) === rank(b) && (a._used || 0) < (b._used || 0))
}

// Queue order: rank, then the most recently used, then the oldest job.
function order (a, b) {
  return rank(a.space) - rank(b.space) || (b.space._used || 0) - (a.space._used || 0) || a.seq - b.seq
}

module.exports = { Network }
