// The I2P swarm over the SAM stand-in: two peers joining one topic connect once (secret-stream with their device
// keys); dht.connect reaches a peer by its key; a known address is dialed without waiting for the DHT.

const test = require('brittle')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const crypto = require('hypercore-crypto')
const { I2PSwarm, keyTopic } = require('../../../lib/i2p/swarm.js')
const { standIn } = require('./_sam.js')
const { eventually } = require('../helpers.js')

const topicOf = (s) => { const out = b4a.alloc(32); sodium.crypto_generichash(out, b4a.from(s)); return out }

async function swarms (t, n, opts = {}) {
  const router = await standIn(opts.router)
  const sam = { port: router.port }
  const all = []
  t.teardown(async () => { await Promise.all(all.map((s) => s.destroy())); await router.close() }, { order: 10 })
  const first = await I2PSwarm.open({ sam, keyPair: crypto.keyPair(), announceKey: true, full: true })
  all.push(first)
  for (let i = 1; i < n; i++) all.push(await I2PSwarm.open({ sam, keyPair: crypto.keyPair(), bootstrap: [first.node.bootstrapAddress], full: true, ...(opts.each || {}) }))
  return all
}

test('i2p swarm: two peers on one topic connect once, with their device keys, and talk', async (t) => {
  const [a, b] = await swarms(t, 2)
  const got = []
  a.on('connection', (c) => c.on('data', (d) => got.push(b4a.toString(d))))
  b.on('connection', (c) => c.write(b4a.from('hi from b')))
  const topic = topicOf('space')
  a.join(topic, { server: true, client: true })
  await a.node.announce(topic) // stored before b looks (lib/network.js looks again otherwise)
  await b.join(topic, { server: true, client: true }).flushed()
  t.ok(await eventually(() => got.includes('hi from b'), 20000), 'a got b\'s bytes')
  t.is(a.connections.size, 1)
  t.alike([...a.connections][0].remotePublicKey, b.keyPair.publicKey)
  await a.join(topic).refresh()
  await eventually(() => a.connections.size === 1 && b.connections.size === 1, 5000)
  t.is(a.connections.size, 1, 'a second look adds no second connection')
})

test('i2p swarm: dht.connect reaches a peer by its key (announced), the key checked', async (t) => {
  const [a, b] = await swarms(t, 2)
  await a.node.announce(keyTopic(a.keyPair.publicKey)) // as ready() does, in the background
  const stream = b.dht.connect(a.keyPair.publicKey)
  t.ok(await stream.opened, 'opened')
  t.alike(stream.remotePublicKey, a.keyPair.publicKey)
  const wrong = b.dht.connect(crypto.keyPair().publicKey)
  t.absent(await wrong.opened, 'a key no one announced: not opened')
})

test('i2p swarm: a topic\'s known address is dialed at once, without the DHT', async (t) => {
  const [a, b] = await swarms(t, 2)
  const topic = topicOf('known')
  a.join(topic, { server: false, client: false }) // not announced: only reachable by its address
  b._find = I2PSwarm.prototype._find // as is
  b.known.set(b4a.toString(topic, 'hex'), new Set([a.address]))
  const t0 = Date.now()
  await b.join(topic, { server: false, client: true }).flushed()
  t.is(b.connections.size, 1, 'connected through the known address')
  t.ok(Date.now() - t0 < 10000)
})
