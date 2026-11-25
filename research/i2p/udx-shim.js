// A stand-in for udx-native that dht-rpc accepts as `opts.udx`, carrying its
// UDP packets as SAM datagrams. dht-rpc is not forked.
//
// dht-rpc speaks IPv4 host:port (6 bytes) and checks a node's id against
// hash(host, port), so each I2P destination gets a fixed fake address:
// host = the first 4 bytes of its hash, port = the I2P datagram port. Every
// node computes the same fake address for the same destination.
//
// The catch: replies list "closer nodes" as fake addresses, which can't be
// turned back into destinations. So each datagram carries a prefix with the
// full destination of every closer node it lists (and, for RAW, the sender's
// own, since RAW datagrams don't say who sent them).
//
// shortcut: 32-bit host collisions are ignored (fine for a few test nodes, not for a real network).

const { EventEmitter } = require('events')
const c = require('compact-encoding')
const sam = require('./sam.js')

const RESPONSE = 0x13 // dht-rpc's RESPONSE_ID

const hostOf = (hash) => `${hash[0]}.${hash[1]}.${hash[2]}.${hash[3]}`

// Reads the closer nodes of a dht-rpc response, or [] (see dht-rpc lib/io.js).
function closerNodes (msg) {
  if (msg[0] !== RESPONSE) return []
  try {
    const state = { start: 1, end: msg.length, buffer: msg }
    const flags = c.uint.decode(state)
    state.start += 2 + 6 // tid, to
    if (flags & 1) state.start += 32
    if (flags & 2) state.start += 32
    if (!(flags & 4)) return []
    const n = c.uint.decode(state)
    const out = []
    for (let i = 0; i < n; i++) {
      const b = msg.subarray(state.start, state.start + 6)
      out.push(`${b[0]}.${b[1]}.${b[2]}.${b[3]}`)
      state.start += 6
    }
    return out
  } catch { return [] }
}

class FakeSocket extends EventEmitter {
  constructor (udx) { super(); this.udx = udx; this.bound = false; this._port = 0 }
  bind (port) {
    if (port === 0) do port = 1 + Math.floor(Math.random() * 65534); while (this.udx.sockets.has(port))
    if (this.udx.sockets.has(port)) throw new Error('port in use')
    this._port = port
    this.bound = true
    this.udx.sockets.set(port, this)
  }

  address () { return { host: this.udx.host, family: 4, port: this._port } }
  trySend (buf, port, host) { this.udx._send(this._port, buf, port, host) }
  async send (buf, port, host) { this.udx._send(this._port, buf, port, host); return true }
  async close () { this.udx.sockets.delete(this._port); this.bound = false; this.emit('close') }
}

class I2PUDX {
  // style: 'DATAGRAM' (signed sender) or 'RAW' (sender written in the prefix, unchecked)
  // datagrams: sam.datagrams, or a fake with the same shape (test.js)
  static async open ({ style = 'DATAGRAM', sam: samOpts = {}, datagrams = sam.datagrams } = {}) {
    const u = new I2PUDX(style)
    u.session = await datagrams(style, { sam: samOpts, onmessage: (m, info) => u._onmessage(m, info) })
    u.dest = u.session.dest
    u.hash = u.session.hash
    u.host = hostOf(u.hash)
    u.learn(u.dest)
    return u
  }

  constructor (style) {
    this.style = style
    this.sockets = new Map()
    this.known = new Map() // fake host -> destination (I2P base64)
    this.stats = { tx: 0, rx: 0, txBytes: 0, rxBytes: 0, unknownHost: 0 }
  }

  learn (dest) { this.known.set(hostOf(sam.destHash(dest)), dest) }
  createSocket () { return new FakeSocket(this) }
  watchNetworkInterfaces () { const e = new EventEmitter(); e.destroy = () => {}; e.interfaces = []; return e }
  networkInterfaces () { return [] }
  async lookup (host) { return { host, family: 4 } }

  // Prefix: from port, to port (emissary drops SAM's FROM_PORT/TO_PORT), [RAW: our destination],
  // then the full destination of each closer node (emissary can't send to a .b32.i2p name).
  _send (fromPort, buf, port, host) {
    const to = this.known.get(host)
    if (!to) { this.stats.unknownHost++; return }
    const dests = closerNodes(buf).map((h) => this.known.get(h)).filter(Boolean)
    const head = Buffer.alloc(4)
    head.writeUInt16BE(fromPort, 0)
    head.writeUInt16BE(port, 2)
    const parts = [head]
    if (this.style === 'RAW') parts.push(...lenPrefixed(this.dest))
    parts.push(Buffer.from([dests.length]))
    for (const d of dests) parts.push(...lenPrefixed(d))
    parts.push(buf)
    const payload = Buffer.concat(parts)
    this.stats.tx++
    this.stats.txBytes += payload.length
    this.session.send(to, payload)
  }

  _onmessage (msg, { dest }) {
    try {
      const fromPort = msg.readUInt16BE(0)
      const toPort = msg.readUInt16BE(2)
      let off = 4
      const take = () => { const n = msg.readUInt16BE(off); const d = toB64(msg.subarray(off + 2, off + 2 + n)); off += 2 + n; return d }
      const from = this.style === 'RAW' ? take() : dest
      const n = msg[off++]
      for (let i = 0; i < n; i++) this.learn(take())
      this.learn(from)
      const sock = this.sockets.get(toPort)
      this.stats.rx++
      this.stats.rxBytes += msg.length
      if (sock) sock.emit('message', msg.subarray(off), { host: hostOf(sam.destHash(from)), port: fromPort, family: 4 })
    } catch {} // a malformed datagram is dropped, like a bad UDP packet
  }

  close () { this.session.close() }
}

const toB64 = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '~')
function lenPrefixed (b64) {
  const bin = Buffer.from(b64.replace(/-/g, '+').replace(/~/g, '/'), 'base64')
  const len = Buffer.alloc(2)
  len.writeUInt16BE(bin.length)
  return [len, bin]
}

module.exports = { I2PUDX, hostOf, closerNodes }
