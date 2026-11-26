// Hyperswarm's surface over I2P, for lib/network.js, helpers and holding: join a topic (announce and look up in
// the DHT inside I2P), accept on the session's destination, dht.connect(key) to a peer by its key, connections as
// secret-streams (the device key pair, as on Hyperswarm) over SAM streams. One SAM session per open.
// A join dials the addresses already known for its topic at once, beside the DHT lookup (often slow over I2P):
// the first connection wins, so a slow lookup never holds up a space someone is known for.
// DualSwarm runs it beside Hyperswarm: regular peers over Hyperswarm, I2P-only peers over I2P; one peer reached
// both ways keeps its Hyperswarm connection.
const { EventEmitter } = require('events')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const NoiseSecretStream = require('@hyperswarm/secret-stream')
const safetyCatch = require('safety-catch')
const sam = require('./sam.js')
const { I2PDHT } = require('./dht.js')

const KEY_NS = b4a.from('hypergraph/i2p-peer')
const DIAL_MS = 60000 // an I2P stream takes 5-17 s and a few tries (033)
const MAX_KNOWN = 16 // addresses remembered per topic
const RETRY_MS = 5000 // the router, again, after it stopped

/**
 * @typedef {import('../identity.js').KeyPair} KeyPair
 * @typedef {NoiseSecretStream & { i2p?: string, userData?: any }} Connection a secret-stream; `i2p`: the peer's address
 * @typedef {{ server?: boolean, client?: boolean }} JoinOptions
 * @typedef {Awaited<ReturnType<typeof sam.session>>} Session
 */

/** The DHT topic a peer that can be dialed by its key announces. @param {Uint8Array} publicKey */
function keyTopic (publicKey) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat([KEY_NS, publicKey]))
  return out
}

class Discovery {
  /** @param {I2PSwarm} swarm @param {Uint8Array} topic @param {JoinOptions} opts */
  constructor (swarm, topic, { server = true, client = true }) {
    this.swarm = swarm
    this.topic = topic
    this.hex = b4a.toString(topic, 'hex')
    this.server = server
    this.client = client
    this.destroyed = false
    /** @type {Promise<void>} */
    this._flushed = Promise.resolve()
    this.refresh().catch(safetyCatch)
  }

  flushed () { return this._flushed }

  /** Announces again (a server) and looks again (a client). @param {JoinOptions} [opts] */
  refresh ({ server = this.server, client = this.client } = {}) {
    if (this.destroyed) return Promise.resolve()
    if (this.server && !server) this.swarm.node.unannounce(this.topic)
    this.server = server
    this.client = client
    if (server) this.swarm.node.announce(this.topic).catch(safetyCatch) // in the background: it doesn't gate a join
    this._flushed = client ? this.swarm._find(this) : Promise.resolve()
    return this._flushed
  }

  destroy () {
    if (this.destroyed) return Promise.resolve()
    this.destroyed = true
    if (this.server) this.swarm.node.unannounce(this.topic)
    if (this.swarm.topics.get(this.hex) === this) this.swarm.topics.delete(this.hex)
    return Promise.resolve()
  }
}

class I2PSwarm extends EventEmitter {
  /**
   * Opens one SAM session (a fresh destination, 3-hop tunnels); resolves once its tunnels are built.
   * @param {{ sam: import('./sam.js').SamOptions, keyPair: KeyPair, bootstrap?: string[], client?: boolean, full?: boolean, announceKey?: boolean }} opts
   *   bootstrap: `<address>:<port>` DHT nodes (helpers); client: a client-only DHT node (anonymous identities);
   *   full: a DHT node storing others' records from the start (helpers), not after a long uptime;
   *   announceKey: announce this device's key so dht.connect(key) finds it (never for anonymous identities:
   *   anyone knowing the key could tell when they are online)
   */
  static async open (opts) {
    const session = await sam.session({ sam: opts.sam })
    const swarm = new I2PSwarm(session, opts)
    await swarm.ready()
    return swarm
  }

  /**
   * Emits 'state' `{ state: 'connecting', reason }` when the router's session is lost (the router stopped), then
   * `{ state: 'ready', address }` once a new one (a new destination) is up again; it retries until then.
   * @param {Session} session
   * @param {{ sam?: import('./sam.js').SamOptions, keyPair: KeyPair, bootstrap?: string[], client?: boolean, full?: boolean, announceKey?: boolean }} opts
   */
  constructor (session, { sam: samOpts = session.sam, keyPair, bootstrap = [], client = false, full = false, announceKey = false }) {
    super()
    this.samOpts = samOpts
    this.keyPair = keyPair
    this.announceKey = announceKey
    this.nodeOpts = { bootstrap, ...(client ? { ephemeral: true } : full ? { ephemeral: false, firewalled: false } : {}) }
    /** @type {Session} */
    this.session = session
    this.address = session.identity.address
    this.node = new I2PDHT(session, this.nodeOpts)
    /** @type {Set<Connection>} */
    this.connections = new Set()
    /** @type {Map<string, Connection>} device key hex -> its connection */
    this.peers = new Map()
    /** @type {Map<string, string>} device key hex -> last address it was reached at */
    this.addresses = new Map()
    /** @type {Map<string, Set<string>>} topic hex -> addresses seen serving it */
    this.known = new Map()
    /** @type {Map<string, Discovery>} */
    this.topics = new Map()
    /** @type {Set<string>} addresses being dialed */
    this.dialing = new Set()
    /** @type {Set<string>} device key hex: peers kept dialed (joinPeer) */
    this.kept = new Set()
    this.destroyed = false
    const self = this
    // What blind-peering and blind-peer use of hyperdht.
    this.dht = Object.assign(new EventEmitter(), {
      get destroyed () { return self.destroyed },
      /** @param {Uint8Array} publicKey @param {{ keyPair?: KeyPair }} [opts] */
      connect: (publicKey, opts = {}) => this.#connectKey(publicKey, opts)
    })
    this.#use(session)
  }

  /** @param {Session} session */
  #use (session) {
    session.accept((raw, from) => this.#incoming(raw, from))
    session.socket.socket.once('close', () => { if (!this.destroyed && this.session === session) this.#lost().catch(safetyCatch) })
  }

  // The router stopped (or restarted): a new session, a new DHT node, the topics joined again. Connections over
  // the old one are gone with it.
  async #lost () {
    this.emit('state', { state: 'connecting', reason: 'the I2P router stopped' })
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      if (this.destroyed) return
      let session
      try { session = await sam.session({ sam: this.samOpts }) } catch { continue }
      if (this.destroyed) return session.close()
      this.node.destroy().catch(safetyCatch)
      this.session = session
      this.address = session.identity.address
      this.node = new I2PDHT(session, this.nodeOpts)
      this.#use(session)
      this.emit('state', { state: 'ready', address: this.address }) // reachable again; the DHT comes back beside it
      this.ready().then(() => { for (const d of this.topics.values()) d.refresh().catch(safetyCatch) }, safetyCatch)
      return
    }
  }

  async ready () {
    await this.node.ready()
    if (this.announceKey) this.node.announce(keyTopic(this.keyPair.publicKey)).catch(safetyCatch)
  }

  /** @param {Uint8Array} topic @param {JoinOptions} [opts] */
  join (topic, opts = {}) {
    const hex = b4a.toString(topic, 'hex')
    const old = this.topics.get(hex)
    if (old) { old.refresh(opts).catch(safetyCatch); return old }
    const d = new Discovery(this, topic, opts)
    this.topics.set(hex, d)
    return d
  }

  /** @param {Uint8Array} topic */
  leave (topic) {
    const d = this.topics.get(b4a.toString(topic, 'hex'))
    return d ? d.destroy() : Promise.resolve()
  }

  listen () { return Promise.resolve() } // always accepting
  flush () { return Promise.all([...this.topics.values()].map((d) => d.flushed())).then(() => {}) }
  suspend () { return Promise.resolve() }
  resume () { return Promise.resolve() }

  /** Keeps `publicKey` dialed at its last address. @param {Uint8Array} publicKey */
  joinPeer (publicKey) {
    const hex = b4a.toString(publicKey, 'hex')
    this.kept.add(hex)
    const address = this.addresses.get(hex)
    if (address && !this.peers.has(hex)) this.#dial(address, publicKey).catch(safetyCatch)
  }

  /** @param {Uint8Array} publicKey */
  leavePeer (publicKey) { this.kept.delete(b4a.toString(publicKey, 'hex')) }

  // A join's look: known addresses at once, the DHT lookup beside them; done at the first connection, or when all
  // tries are over.
  /** @param {Discovery} d @returns {Promise<void>} */
  _find (d) {
    return new Promise((resolve) => {
      let open = 1
      const settle = () => { if (--open === 0) resolve() }
      /** @param {string} address */
      const dial = (address) => {
        open++
        this.#dial(address, undefined, d.topic).then((conn) => {
          if (!conn) return
          this.#remember(d.hex, address)
          resolve()
        }, safetyCatch).finally(settle)
      }
      for (const address of this.known.get(d.hex) || []) dial(address)
      this.node.lookup(d.topic, { onfound: (f) => { if (!d.destroyed) dial(f.address) } }).catch(safetyCatch).finally(settle)
    })
  }

  /** @param {string} topicHex @param {string} address */
  #remember (topicHex, address) {
    let set = this.known.get(topicHex)
    if (!set) this.known.set(topicHex, (set = new Set()))
    set.delete(address)
    set.add(address)
    if (set.size > MAX_KNOWN) set.delete(/** @type {string} */ (set.values().next().value))
  }

  // Dials an address (unless already connected to it or dialing it); resolves with the connection once its
  // handshake is done, or null.
  /** @param {string} address @param {Uint8Array} [remotePublicKey] @param {Uint8Array} [topic] the join it is for @returns {Promise<Connection | null>} */
  async #dial (address, remotePublicKey, topic) {
    if (this.destroyed || address === this.address || this.dialing.has(address)) return null
    for (const c of this.connections) if (c.i2p === address) return c
    this.dialing.add(address)
    try {
      const raw = await this.session.connect(address, DIAL_MS)
      const conn = /** @type {Connection} */ (new NoiseSecretStream(true, raw, { keyPair: this.keyPair, ...(remotePublicKey ? { remotePublicKey } : {}) }))
      return await this.#opened(conn, address, topic)
    } catch { return null } finally { this.dialing.delete(address) }
  }

  /** @param {import('./sam.js').RawStream} raw @param {string} from */
  #incoming (raw, from) {
    if (this.destroyed) return raw.destroy()
    const conn = /** @type {Connection} */ (new NoiseSecretStream(false, raw, { keyPair: this.keyPair }))
    this.#opened(conn, from).catch(safetyCatch)
  }

  /** @param {Connection} conn @param {string} address @param {Uint8Array} [topic] @returns {Promise<Connection | null>} */
  async #opened (conn, address, topic) {
    conn.on('error', safetyCatch)
    conn.i2p = address
    if (!(await conn.opened) || this.destroyed) { conn.destroy(); return null }
    const hex = b4a.toString(conn.remotePublicKey, 'hex')
    const other = this.peers.get(hex)
    if (other && !other.destroyed) {
      if (keep(other, conn, this.keyPair.publicKey) === other) { conn.destroy(); return other }
      other.destroy()
    }
    this.addresses.set(hex, address)
    this.peers.set(hex, conn)
    this.connections.add(conn)
    conn.on('close', () => {
      this.connections.delete(conn)
      if (this.peers.get(hex) === conn) this.peers.delete(hex)
    })
    this.emit('connection', conn, { publicKey: conn.remotePublicKey, topics: topic ? [topic] : [] }) // as Hyperswarm's PeerInfo: the topic dialed for
    return conn
  }

  // A stream to a peer by its key, returned at once and opened when found: its last address, else the DHT topic it
  // announces itself on. Not a swarm connection (as with hyperdht's connect).
  /** @param {Uint8Array} publicKey @param {{ keyPair?: KeyPair }} opts */
  #connectKey (publicKey, opts) {
    const keyPair = opts.keyPair || this.keyPair
    const stream = /** @type {Connection} */ (new NoiseSecretStream(true, null, { keyPair, remotePublicKey: publicKey, autoStart: false }))
    stream.on('error', safetyCatch)
    const go = async () => {
      let address = this.addresses.get(b4a.toString(publicKey, 'hex'))
      if (!address) address = await this.#first(keyTopic(publicKey))
      if (!address) throw new Error('No I2P address for this peer')
      const raw = await this.session.connect(address, DIAL_MS)
      if (stream.destroyed) return raw.destroy()
      stream.i2p = address
      stream.start(raw, { keyPair }) // start() reads the key pair from its own options
    }
    go().catch((err) => stream.destroy(err))
    return stream
  }

  // The first address the DHT gives for `topic`, without waiting for the rest of the lookup.
  /** @param {Uint8Array} topic @returns {Promise<string | undefined>} */
  #first (topic) {
    return new Promise((resolve) => {
      this.node.lookup(topic, { onfound: (f) => resolve(f.address) }).then(() => resolve(undefined), () => resolve(undefined))
    })
  }

  /** @param {{ force?: boolean }} [opts] */
  async destroy (opts) {
    if (this.destroyed) return
    this.destroyed = true
    for (const d of this.topics.values()) await d.destroy()
    for (const c of this.connections) c.destroy()
    this.dht.emit('close')
    await this.node.destroy().catch(safetyCatch) // closes the session too
  }
}

// Two connections to one peer: both sides keep the same one, the one dialed by the lower key (or the older, if one
// side dialed twice).
/** @param {Connection} a the older @param {Connection} b @param {Uint8Array} me */
function keep (a, b, me) {
  if (a.isInitiator === b.isInitiator) return a
  const dialer = (/** @type {Connection} */ c) => (c.isInitiator ? me : c.remotePublicKey)
  return b4a.compare(dialer(a), dialer(b)) <= 0 ? a : b
}

class DualSwarm extends EventEmitter {
  /** @param {import('hyperswarm')} hyperswarm the I2P side joins later (attach), once its tunnels are built */
  constructor (hyperswarm) {
    super()
    this.hyperswarm = hyperswarm
    /** @type {I2PSwarm | null} */
    this.i2p = null
    this.keyPair = hyperswarm.keyPair
    this.dht = hyperswarm.dht // helpers and holders are regular peers
    /** @type {Map<string, { topic: Uint8Array, opts: JoinOptions, i2p: Discovery | null, destroyed: boolean }>} */
    this.joins = new Map()
    /** @type {Set<string>} device key hex (joinPeer) */
    this.kept = new Set()
    hyperswarm.on('connection', (/** @type {Connection} */ conn, /** @type {unknown} */ info) => {
      if (this.i2p) for (const c of this.i2p.connections) if (b4a.equals(c.remotePublicKey, conn.remotePublicKey)) c.destroy()
      this.emit('connection', conn, info)
    })
  }

  /** @param {I2PSwarm} i2p */
  attach (i2p) {
    if (this.i2p) return
    this.i2p = i2p
    i2p.on('connection', (conn, info) => {
      if ([...this.hyperswarm.connections].some((c) => b4a.equals(c.remotePublicKey, conn.remotePublicKey))) return conn.destroy()
      this.emit('connection', conn, info)
    })
    for (const j of this.joins.values()) if (!j.destroyed) j.i2p = i2p.join(j.topic, j.opts)
    for (const hex of this.kept) i2p.joinPeer(b4a.from(hex, 'hex'))
  }

  get connections () { return new Set([...this.hyperswarm.connections, ...(this.i2p ? this.i2p.connections : [])]) }

  /** Both: Hyperswarm decides when the join is flushed; I2P looks in the background. @param {Uint8Array} topic @param {JoinOptions} [opts] */
  join (topic, opts = {}) {
    const a = this.hyperswarm.join(topic, opts)
    const j = { topic, opts, i2p: this.i2p ? this.i2p.join(topic, opts) : null, destroyed: false }
    this.joins.set(b4a.toString(topic, 'hex'), j)
    return {
      get destroyed () { return a.destroyed },
      flushed: () => a.flushed(),
      refresh: (/** @type {JoinOptions} */ o) => {
        if (o) j.opts = { ...j.opts, ...o }
        if (j.i2p) j.i2p.refresh(o).catch(safetyCatch)
        return a.refresh(o)
      },
      destroy: () => {
        j.destroyed = true
        if (this.joins.get(b4a.toString(topic, 'hex')) === j) this.joins.delete(b4a.toString(topic, 'hex'))
        return Promise.all([a.destroy(), j.i2p && j.i2p.destroy()]).then(() => {})
      }
    }
  }

  /** @param {Uint8Array} topic */
  leave (topic) {
    const j = this.joins.get(b4a.toString(topic, 'hex'))
    if (j) { j.destroyed = true; this.joins.delete(b4a.toString(topic, 'hex')) }
    return Promise.all([this.hyperswarm.leave(topic), this.i2p && this.i2p.leave(topic)]).then(() => {})
  }

  listen () { return this.hyperswarm.listen() }
  flush () { return this.hyperswarm.flush() }
  /** @param {Uint8Array} key */
  joinPeer (key) { this.kept.add(b4a.toString(key, 'hex')); this.hyperswarm.joinPeer(key); if (this.i2p) this.i2p.joinPeer(key) }
  /** @param {Uint8Array} key */
  leavePeer (key) { this.kept.delete(b4a.toString(key, 'hex')); this.hyperswarm.leavePeer(key); if (this.i2p) this.i2p.leavePeer(key) }
  suspend () { return this.hyperswarm.suspend() }
  resume () { return this.hyperswarm.resume() }
  /** @param {{ force?: boolean }} [opts] */
  async destroy (opts) {
    await Promise.all([this.hyperswarm.destroy(opts), this.i2p && this.i2p.destroy()])
  }
}

module.exports = { I2PSwarm, DualSwarm, keyTopic }
