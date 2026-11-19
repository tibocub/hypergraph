// Can plain hyperdht be made to use the blind relay only? Server and client
// veto holepunching and share no LAN address; both name the relay. Prints
// which path the connection took and what the relay counted.
//
// node research/anonymity/relay-only.js

const createTestnet = require('hyperdht/testnet')
const HyperDHT = require('hyperdht')
const BlindRelay = require('blind-relay')

async function main () {
  const testnet = await createTestnet(3)
  const { bootstrap } = testnet
  const relayNode = new HyperDHT({ bootstrap })
  const relayKp = HyperDHT.keyPair()
  const relay = new BlindRelay.Server({ createStream: (opts) => relayNode.createRawStream(opts) })
  const rs = relayNode.createServer((socket) => relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => {}))
  await rs.listen(relayKp)
  const relayPort = relayNode.address().port

  const a = new HyperDHT({ bootstrap })
  const b = new HyperDHT({ bootstrap })
  const server = a.createServer({ holepunch: false, shareLocalAddress: false, relayThrough: relayKp.publicKey }, (conn) => {
    conn.on('data', (d) => conn.write(d))
  })
  const akp = HyperDHT.keyPair()
  await server.listen(akp)

  const t = Date.now()
  const conn = b.connect(akp.publicKey, { holepunch: () => false, localConnection: false, relayThrough: relayKp.publicKey })
  conn.on('error', (err) => console.log('client error', err.code || err.message))
  await new Promise((resolve) => conn.once('open', resolve))
  const openMs = Date.now() - t
  conn.write('ping')
  await new Promise((resolve) => conn.once('data', resolve))
  const out = {
    openMs,
    path: conn.rawStream.remotePort === relayPort ? 'via relay' : `direct (${conn.rawStream.remoteHost}:${conn.rawStream.remotePort})`,
    relayPort,
    relayStats: relay.stats
  }
  console.log(JSON.stringify(out))
  conn.destroy()
  await Promise.all([a.destroy(), b.destroy(), relayNode.destroy()])
  await testnet.destroy()
}

main().catch((err) => { console.error(err); process.exitCode = 1 })
