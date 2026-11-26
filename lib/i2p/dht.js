// Discovery inside I2P: dht-rpc over SAM datagrams, two commands. ANNOUNCE stores "this destination serves this
// topic" at the nodes closest to the topic, signed by the destination's own key (fresh per open, so records link
// nothing across opens); LOOKUP returns the destinations stored there. Records expire as hyperdht's do.
// Client-only nodes (anonymous identities) store nothing and answer no lookups: their online time isn't a node's.
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const DHT = require('./dht-rpc/index.js')
const { I2PUDX } = require('./udx.js')
const sam = require('./sam.js')
const { addressOf, signingKeyOf, isEd25519 } = require('./address.js')

const ANNOUNCE = 0
const LOOKUP = 1
const TTL_MS = 20 * 60 * 1000
const REANNOUNCE_MS = 10 * 60 * 1000
const SKEW_MS = 5 * 60 * 1000
const MAX_PER_TOPIC = 20
const MAX_TOPICS = 10000
const MAX_REPLY = 10 // ~460 bytes each: with 20 closer nodes a reply stays well under i2pd's 8 KB SAM buffer
const SERVER_PORT = 1 // fixed, so a node's bootstrap address is `<address>:1`
const NS = b4a.from('hypergraph/i2p-announce')

/** @typedef {{ dest: Uint8Array, time: number, signature: Uint8Array }} Record */

/** @type {import('compact-encoding').Encoder<Record>} */
const record = {
  preencode (state, m) { c.buffer.preencode(state, m.dest); c.uint.preencode(state, m.time); c.fixed64.preencode(state, m.signature) },
  encode (state, m) { c.buffer.encode(state, m.dest); c.uint.encode(state, m.time); c.fixed64.encode(state, m.signature) },
  decode (state) { return { dest: /** @type {Uint8Array} */ (c.buffer.decode(state)), time: c.uint.decode(state), signature: c.fixed64.decode(state) } }
}
const records = c.array(record)

/** @param {Uint8Array} topic @param {number} time */
const signable = (topic, time) => b4a.concat([NS, topic, c.encode(c.uint, time)])

/** @param {Record} r @param {Uint8Array} topic @param {number} now */
function valid (r, topic, now) {
  if (!isEd25519(r.dest) || r.time * 1000 > now + SKEW_MS || r.time * 1000 < now - TTL_MS) return false
  return sodium.crypto_sign_verify_detached(r.signature, signable(topic, r.time), signingKeyOf(r.dest))
}

class I2PDHT {
  /**
   * Opens a datagram session (resolves once its tunnels are built) and joins the DHT.
   * @param {{ sam: import('./sam.js').SamOptions, bootstrap?: string[], ephemeral?: boolean, firewalled?: boolean }} opts
   *   bootstrap: `<address>:<port>` of known nodes (helpers); ephemeral: true for a client-only node, false for a
   *   node from the start (tests, helpers), unset to let dht-rpc decide by uptime
   */
  static async open ({ sam: samOpts, bootstrap = [], ephemeral, firewalled }) {
    const session = await sam.session({ sam: samOpts })
    return new I2PDHT(session, { bootstrap, ephemeral, firewalled })
  }

  /**
   * @param {Awaited<ReturnType<typeof sam.session>>} session
   * @param {{ bootstrap: string[], ephemeral?: boolean, firewalled?: boolean }} opts
   */
  constructor (session, { bootstrap, ephemeral, firewalled }) {
    this.session = session
    this.bootstrap = bootstrap
    this.identity = session.identity
    this.dht = new DHT({
      udx: new I2PUDX(session),
      bootstrap,
      port: SERVER_PORT,
      anyPort: false,
      adaptiveTimeout: { min: 3000, max: 20000 }, // I2P round trips ~1 s; first datagrams to a destination often lost
      ...(ephemeral === undefined ? {} : { ephemeral }),
      ...(firewalled === undefined ? {} : { firewalled })
    })
    /** @type {Map<string, Map<string, { r: Record, expires: number }>>} topic hex -> address -> record */
    this.stored = new Map()
    /** @type {Map<string, ReturnType<typeof setInterval>>} */
    this.announcing = new Map()
    // An I2P address is known and the same to everyone (no NAT): say so, as dht-rpc's bootstrapper does, or a node
    // waits for many peers to report its address before it can become a full node.
    if (ephemeral !== true) this.dht._nat.add(this.identity.address, SERVER_PORT)
    this.dht.on('request', (/** @type {any} */ req) => this.#onrequest(req))
  }

  /** `<address>:<port>`: what others put in `bootstrap` to reach this node. */
  get bootstrapAddress () { return this.identity.address + ':' + SERVER_PORT }

  /**
   * Resolves once the node knows at least one other (or has no bootstrap nodes). dht-rpc pings its bootstrap nodes
   * once; over I2P the first datagrams to a destination are often lost, so they're pinged again, up to ~2 minutes.
   */
  async ready () {
    await this.dht.ready()
    for (let i = 0; i < 20 && this.bootstrap.length && !this.dht.toArray().length && !this.dht.destroyed; i++) {
      await Promise.allSettled(this.bootstrap.map((b) => {
        const at = b.lastIndexOf(':')
        return this.dht.ping({ host: b.slice(0, at), port: Number(b.slice(at + 1)) })
      }))
    }
    if (this.dht.toArray().length) await this.dht.findNode(this.dht.table.id).finished().catch(() => {})
  }

  /**
   * Announces this destination for `topic` now and every 10 minutes until `unannounce`.
   * @param {Uint8Array} topic 32 bytes
   */
  async announce (topic) {
    const key = b4a.toString(topic, 'hex')
    if (!this.announcing.has(key)) this.announcing.set(key, setInterval(() => { this.#announce(topic).catch(() => {}) }, REANNOUNCE_MS))
    await this.#announce(topic)
  }

  /** @param {Uint8Array} topic */
  unannounce (topic) {
    const key = b4a.toString(topic, 'hex')
    clearInterval(this.announcing.get(key))
    this.announcing.delete(key)
  }

  /** @param {Uint8Array} topic */
  async #announce (topic) {
    const time = Math.floor(Date.now() / 1000)
    const signature = b4a.alloc(64)
    sodium.crypto_sign_detached(signature, signable(topic, time), this.identity.keyPair.secretKey)
    const value = c.encode(record, { dest: this.identity.dest, time, signature })
    await this.dht.query({ target: topic, command: ANNOUNCE, value }, { commit: true }).finished()
  }

  /**
   * The destinations announced for `topic`, checked (signature, age), without this one.
   * @param {Uint8Array} topic 32 bytes
   * @returns {Promise<{ dest: Uint8Array, address: string }[]>}
   */
  async lookup (topic) {
    /** @type {Map<string, Uint8Array>} */
    const found = new Map()
    const now = Date.now()
    // This node's own records too: it may be one of the closest (a small DHT, or a helper)
    for (const e of this.stored.get(b4a.toString(topic, 'hex'))?.values() || []) {
      if (e.expires > now && addressOf(e.r.dest) !== this.identity.address) found.set(addressOf(e.r.dest), e.r.dest)
    }
    for await (const r of this.dht.query({ target: topic, command: LOOKUP, value: null })) {
      const reply = /** @type {{ value: Uint8Array | null }} */ (r)
      if (!reply.value) continue
      let list
      try { list = c.decode(records, reply.value) } catch { continue }
      for (const rec of list) {
        if (!valid(rec, topic, now)) continue
        const address = addressOf(rec.dest)
        if (address !== this.identity.address) found.set(address, rec.dest)
      }
    }
    return [...found].map(([address, dest]) => ({ address, dest }))
  }

  /** @param {{ command: number, target: Uint8Array | null, value: Uint8Array | null, token: Uint8Array | null, reply (v: Uint8Array | null): void }} req */
  #onrequest (req) {
    if (!req.target) return req.reply(null)
    const key = b4a.toString(req.target, 'hex')
    const now = Date.now()
    const here = this.stored.get(key)
    if (here) for (const [a, e] of here) if (e.expires < now) here.delete(a)
    if (req.command === LOOKUP) {
      const list = here ? [...here.values()].map((e) => e.r).slice(-MAX_REPLY) : []
      return req.reply(list.length ? c.encode(records, list) : null)
    }
    if (req.command !== ANNOUNCE || !req.token || !req.value) return req.reply(null) // the query pass, before commit
    let r
    try { r = c.decode(record, req.value) } catch { return req.reply(null) }
    if (!valid(r, req.target, now)) return req.reply(null)
    if (!here && this.stored.size >= MAX_TOPICS) return req.reply(null)
    const map = here || new Map()
    const address = addressOf(r.dest)
    map.delete(address) // re-added last: the newest go out in replies
    map.set(address, { r, expires: now + TTL_MS })
    if (map.size > MAX_PER_TOPIC) map.delete(/** @type {string} */ (map.keys().next().value))
    this.stored.set(key, map)
    req.reply(null)
  }

  async destroy () {
    for (const t of this.announcing.values()) clearInterval(t)
    this.announcing.clear()
    await this.dht.destroy()
    this.session.close()
  }
}

module.exports = { I2PDHT, ANNOUNCE, LOOKUP, TTL_MS, record }
