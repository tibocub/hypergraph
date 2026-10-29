// Networking (research R17): one Hyperswarm per instance, one topic per space
// (its discovery key). Each connection replicates the Corestore and opens the
// space channel of every space this instance holds. Members that come online
// at the same moment usually miss each other's first lookup: each topic looks
// again after a short, random, doubling wait until a member is found (v1's
// re-look, src/networking.js).

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

class Network {
  // hg: store, _spaces (Map), emit('connection')
  constructor (hg, { bootstrap, keyPair = null } = {}) {
    this.hg = hg
    this.bootstrap = bootstrap
    this.keyPair = keyPair
    this.swarm = null
    this.wakeup = new ProtomuxWakeup()
    this.connections = new Set()
    this.topics = new Map() // space hex -> discovery
    this.timers = new Set()
    this.redialing = new Set() // device hex: peers dialed again after a dead connection
    this.closed = false
  }

  get connected () { return !!this.swarm }

  async connect () {
    if (this.swarm || this.closed) return
    this.swarm = new Hyperswarm({ ...(this.bootstrap ? { bootstrap: this.bootstrap } : {}), ...(this.keyPair ? { keyPair: this.keyPair } : {}) })
    this.swarm.on('connection', (conn) => this.#onConnection(conn))
    for (const space of this.hg._spaces.values()) if (space._helpers) space._helpers.update() // spec 013: needs the DHT
    await Promise.all([...this.hg._spaces.values()].map((space) => this.join(space)))
  }

  // Starts finding the members of a space (now, or at connect()).
  async join (space) {
    if (!this.swarm || this.closed || this.topics.has(space.hex)) return
    for (const conn of this.connections) space.directory.attach(conn.userData, conn.remotePublicKey)
    const discovery = this.swarm.join(space.discoveryKey, { server: true, client: true })
    this.topics.set(space.hex, discovery)
    this.#relook(space, discovery, 0)
    await discovery.flushed().catch(safetyCatch)
  }

  // Stops finding the members of a space (one opened here but not joined).
  async leave (space) {
    const discovery = this.topics.get(space.hex)
    if (!discovery) return
    this.topics.delete(space.hex)
    await discovery.destroy()
  }

  #relook (space, discovery, attempt) {
    if (attempt >= RELOOK_MS.length) return
    this.#later(RELOOK_MS[attempt] + Math.floor(Math.random() * 500), async () => {
      if (this.closed || discovery.destroyed || space.closed || space.directory.peers > 0) return
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
        if (!space.closed && b4a.equals(space.discoveryKey, id)) space.directory.attach(mux, conn.remotePublicKey)
      }
    })
    for (const space of this.hg._spaces.values()) space.directory.attach(mux, conn.remotePublicKey)
    this.hg.emit('connection', { publicKey: z32.encode(conn.remotePublicKey) })
  }

  async close () {
    this.closed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
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

module.exports = { Network }
