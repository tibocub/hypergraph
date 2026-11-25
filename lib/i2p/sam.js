// A SAM v3 client: the I2P router's local API, on 127.0.0.1 only. One TCP socket per session; datagrams go both
// ways on that socket (no UDP), as i2pd does when a session is created without a PORT.
const net = require('net')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { fromI2PBase64, publicOf, addressOf, signingKeyPair, SIG_TYPE } = require('./address.js')

const HOPS = 'inbound.length=3 outbound.length=3'
const HELLO_MS = 10000

/**
 * @typedef {{ host?: string, port: number }} SamOptions where the router's SAM listens; host is always loopback
 * @typedef {Record<string, string>} Reply a reply line's KEY=VALUE pairs, plus `_` for its first two words
 * @typedef {{ dest: Uint8Array, address: string, keyPair: { publicKey: Uint8Array, secretKey: Uint8Array } }} Identity
 *   a session's destination: binary public destination, its address (base32 of its hash), its Ed25519 key pair
 */

/** @param {string} line @returns {Reply} */
function parse (line) {
  const words = line.trim().split(' ')
  /** @type {Reply} */
  const out = { _: words.slice(0, 2).join(' ') }
  for (const w of words.slice(2)) {
    const i = w.indexOf('=')
    if (i > 0) out[w.slice(0, i)] = w.slice(i + 1).replace(/^"|"$/g, '')
  }
  return out
}

class SamSocket {
  /** @param {net.Socket} socket */
  constructor (socket) {
    this.socket = socket
    /** @type {Uint8Array} */
    this.buf = b4a.alloc(0)
    /** @type {((r: Reply) => void)[]} */
    this.waiting = []
    /** @type {(data: Uint8Array, from: Uint8Array, fromPort: number, toPort: number) => void} */
    this.ondatagram = () => {}
    this.closed = false
    socket.on('data', (d) => { this.buf = b4a.concat([this.buf, /** @type {Uint8Array} */ (d)]); this.#drain() })
    socket.on('error', () => {})
    socket.on('close', () => {
      this.closed = true
      for (const w of this.waiting.splice(0)) w({ _: 'CLOSED', RESULT: 'CLOSED' })
    })
  }

  #drain () {
    for (;;) {
      const nl = this.buf.indexOf(10)
      if (nl === -1) return
      const r = parse(b4a.toString(this.buf.subarray(0, nl)))
      if (r._ === 'DATAGRAM RECEIVED') {
        const size = Number(r.SIZE)
        if (this.buf.length < nl + 1 + size) return // the rest is still coming
        const data = this.buf.subarray(nl + 1, nl + 1 + size)
        this.buf = this.buf.subarray(nl + 1 + size)
        try { this.ondatagram(data, fromI2PBase64(r.DESTINATION), Number(r.FROM_PORT) || 0, Number(r.TO_PORT) || 0) } catch {}
        continue
      }
      this.buf = this.buf.subarray(nl + 1)
      const w = this.waiting.shift()
      if (w) w(r)
    }
  }

  /** @param {string} line @param {number} [ms] 0: no timeout @returns {Promise<Reply>} */
  ask (line, ms = 0) {
    if (this.closed) return Promise.resolve({ _: 'CLOSED', RESULT: 'CLOSED' })
    return new Promise((resolve, reject) => {
      const timer = ms ? setTimeout(() => { this.destroy(); reject(new Error('SAM did not answer: ' + line.split(' ', 2).join(' '))) }, ms) : null
      this.waiting.push((r) => { if (timer) clearTimeout(timer); resolve(r) })
      this.socket.write(line + '\n')
    })
  }

  destroy () { this.socket.destroy() }
}

/** @param {SamOptions} sam @returns {Promise<SamSocket>} */
function connect ({ host = '127.0.0.1', port }) {
  if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('SAM is reached on 127.0.0.1 only')
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host)
    socket.once('error', reject)
    socket.once('connect', async () => {
      socket.off('error', reject)
      const s = new SamSocket(socket)
      try {
        const r = await s.ask('HELLO VERSION MIN=3.1 MAX=3.3', HELLO_MS)
        if (r.RESULT !== 'OK') throw new Error('SAM HELLO: ' + (r.RESULT || r._))
        resolve(s)
      } catch (err) { s.destroy(); reject(err) }
    })
  })
}

/**
 * A datagram session: a fresh destination with 3-hop tunnels, never saved. Resolves once its tunnels are built
 * (the router answers SESSION CREATE then), which takes seconds to minutes.
 * @param {{ sam: SamOptions, options?: string, ondatagram?: (data: Uint8Array, from: Uint8Array, fromPort: number, toPort: number) => void }} opts
 *   options: more SAM session options; ondatagram gets the sender's binary destination, checked by the router
 */
async function datagrams ({ sam, options = '', ondatagram }) {
  const s = await connect(sam)
  const id = 'hg' + b4a.toString(random(6), 'hex')
  const r = await s.ask(`SESSION CREATE STYLE=DATAGRAM ID=${id} DESTINATION=TRANSIENT SIGNATURE_TYPE=${SIG_TYPE} ${HOPS} ${options}`.trim())
  if (r.RESULT !== 'OK') { s.destroy(); throw new Error('SAM SESSION CREATE: ' + (r.RESULT || r._) + (r.MESSAGE ? ' ' + r.MESSAGE : '')) }
  if (ondatagram) s.ondatagram = ondatagram
  const priv = fromI2PBase64(r.DESTINATION)
  const dest = publicOf(priv)
  return {
    id,
    socket: s,
    /** @type {Identity} */
    identity: { dest, address: addressOf(dest), keyPair: signingKeyPair(priv) },
    /** @param {string} address the receiver's base32 address @param {Uint8Array} data */
    send (address, data) {
      if (s.closed) return
      // One write, under 8 KB in all: i2pd drops a DATAGRAM SEND whose data isn't in the same read as its line.
      s.socket.write(b4a.concat([b4a.from(`DATAGRAM SEND ID=${id} DESTINATION=${address}.b32.i2p SIZE=${data.length}\n`), data]))
    },
    close () { s.destroy() }
  }
}

/** @param {number} n */
function random (n) {
  const b = b4a.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

module.exports = { connect, datagrams, parse, HOPS }
