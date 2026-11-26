// An in-memory stand-in for an I2P router's SAM bridge (no router, no network): a real TCP server on 127.0.0.1
// that speaks the SAM v3 subset lib/i2p/sam.js uses. Destinations are Ed25519 ones laid out as i2pd's, so record
// signatures check out. Several stand-ins can share one `net` (one I2P) to play several routers.
// Options: loss (0-1, datagrams dropped), delayMs (each datagram's trip).

const net = require('net')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const { toI2PBase64, addressOf } = require('../../../lib/i2p/address.js')

function i2pNet () {
  /** @type {Map<string, { deliver: (data: Uint8Array, from: Uint8Array) => void }>} address -> session */
  return { sessions: new Map(), sent: 0 }
}

// A transient Ed25519 destination as i2pd writes it: public (384 bytes of keys, key certificate), 256 bytes of
// encryption private key, then the 32-byte signing seed.
function destination () {
  const seed = b4a.alloc(32)
  sodium.randombytes_buf(seed)
  const pk = b4a.alloc(32)
  const sk = b4a.alloc(64)
  sodium.crypto_sign_seed_keypair(pk, sk, seed)
  const pub = b4a.alloc(391)
  sodium.randombytes_buf(pub.subarray(0, 352))
  pub.set(pk, 352)
  pub.set([5, 0, 4, 0, 7, 0, 4], 384) // key certificate: Ed25519 signing, X25519 encryption
  const enc = b4a.alloc(256)
  sodium.randombytes_buf(enc)
  return { pub, priv: b4a.concat([pub, enc, seed]) }
}

/**
 * @param {{ net?: ReturnType<typeof i2pNet>, loss?: number, delayMs?: number }} [opts]
 * @returns {Promise<{ port: number, net: ReturnType<typeof i2pNet>, close: () => Promise<void> }>}
 */
async function standIn ({ net: world = i2pNet(), loss = 0, delayMs = 5 } = {}) {
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    let buf = b4a.alloc(0)
    /** @type {string | null} */
    let mine = null // this socket's session address
    let raw = false // a stream: bytes only, no more commands
    socket.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); if (mine) world.sessions.delete(mine) })
    socket.on('data', (d) => {
      if (raw) return
      buf = b4a.concat([buf, d])
      for (;;) {
        const nl = buf.indexOf(10)
        if (nl === -1) return
        const line = b4a.toString(buf.subarray(0, nl))
        const params = Object.fromEntries(line.split(' ').slice(2).map((w) => [w.slice(0, w.indexOf('=')), w.slice(w.indexOf('=') + 1)]))
        if (line.startsWith('DATAGRAM SEND')) {
          const size = Number(params.SIZE)
          if (buf.length < nl + 1 + size) return
          const data = b4a.from(buf.subarray(nl + 1, nl + 1 + size))
          buf = buf.subarray(nl + 1 + size)
          const to = world.sessions.get(String(params.DESTINATION).replace(/\.b32\.i2p$/, ''))
          const from = mine && world.sessions.get(mine)
          world.sent++
          if (to && from && Math.random() >= loss) setTimeout(() => to.deliver(data, from.pub), delayMs)
          continue
        }
        buf = buf.subarray(nl + 1)
        if (line.startsWith('HELLO')) socket.write('HELLO REPLY RESULT=OK VERSION=3.3\n')
        else if (line.startsWith('SESSION CREATE')) {
          const d = destination()
          mine = addressOf(d.pub)
          world.sessions.set(mine, {
            id: params.ID,
            pub: d.pub,
            acceptors: [],
            deliver: (data, from) => {
              if (socket.destroyed) return
              socket.write(`DATAGRAM RECEIVED DESTINATION=${toI2PBase64(from)} SIZE=${data.length} FROM_PORT=0 TO_PORT=0\n`)
              socket.write(data)
            }
          })
          socket.write(`SESSION STATUS RESULT=OK DESTINATION=${toI2PBase64(d.priv)}\n`)
        } else if (line.startsWith('STREAM ACCEPT')) {
          const s = [...world.sessions.values()].find((x) => x.id === params.ID)
          if (!s) { socket.write('STREAM STATUS RESULT=INVALID_ID\n'); continue }
          raw = true
          s.acceptors.push(socket)
          socket.write('STREAM STATUS RESULT=OK\n')
          return
        } else if (line.startsWith('STREAM CONNECT')) {
          const from = [...world.sessions.values()].find((x) => x.id === params.ID)
          const to = world.sessions.get(String(params.DESTINATION).replace(/\.b32\.i2p$/, ''))
          raw = true
          const rest = buf
          dial(socket, from, to, rest)
          return
        } else socket.write(line.split(' ', 2).join(' ') + ' REPLY RESULT=I2P_ERROR MESSAGE="not in the stand-in"\n')
      }
    })
  })

  // A stream: waits a moment for the receiver to accept, then pipes both ways.
  async function dial (socket, from, to, rest) {
    for (let i = 0; i < 100 && to && !to.acceptors.length; i++) await new Promise((resolve) => setTimeout(resolve, 50))
    const acceptor = to && to.acceptors.shift()
    if (!from || !acceptor || Math.random() < loss) { socket.write('STREAM STATUS RESULT=CANT_REACH_PEER\n'); socket.destroy(); return }
    await new Promise((resolve) => setTimeout(resolve, delayMs))
    socket.write('STREAM STATUS RESULT=OK\n')
    acceptor.write(toI2PBase64(from.pub) + ' FROM_PORT=0 TO_PORT=0\n')
    if (rest.length) acceptor.write(rest)
    socket.on('data', (d) => acceptor.write(d))
    acceptor.on('data', (d) => socket.write(d))
    socket.on('close', () => acceptor.destroy())
    acceptor.on('close', () => socket.destroy())
  }

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(null)))
  return {
    port: /** @type {import('net').AddressInfo} */ (server.address()).port,
    net: world,
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()) })
  }
}

module.exports = { standIn, i2pNet, destination }
