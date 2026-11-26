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
  const infos = []
  b.on('connection', (c, info) => { infos.push(info); c.write(b4a.from('hi from b')) })
  const topic = topicOf('space')
  a.join(topic, { server: true, client: true })
  await a.node.announce(topic) // stored before b looks (lib/network.js looks again otherwise)
  await b.join(topic, { server: true, client: true }).flushed()
  t.ok(await eventually(() => got.includes('hi from b'), 20000), 'a got b\'s bytes')
  t.is(a.connections.size, 1)
  t.alike([...a.connections][0].remotePublicKey, b.keyPair.publicKey)
  t.alike(infos[0].topics, [topic], 'the dialer is told the topic it dialed for, as by Hyperswarm')
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

test('i2p swarm: after its router restarts, a new session (a new address), the topic joined again', { timeout: 90000 }, async (t) => {
  const routerA = await standIn()
  const routerB = await standIn({ net: routerA.net }) // two routers on one I2P: only b's restarts
  const a = await I2PSwarm.open({ sam: { port: routerA.port }, keyPair: crypto.keyPair(), full: true })
  const b = await I2PSwarm.open({ sam: { port: routerB.port }, keyPair: crypto.keyPair(), bootstrap: [a.node.bootstrapAddress], full: true })
  t.teardown(async () => { await a.destroy(); await b.destroy(); await routerA.close(); await routerB.close() })
  const topic = topicOf('after restart')
  a.join(topic)
  await a.node.announce(topic)
  await b.join(topic).flushed()
  t.is(b.connections.size, 1)
  const states = []
  b.on('state', (s) => states.push(s.state))
  const before = b.address
  routerB.drop()
  t.ok(await eventually(() => states.includes('ready'), 30000), 'connecting, then ready again')
  t.is(states[0], 'connecting')
  t.not(b.address, before, 'a new address')
  t.ok(await eventually(() => b.connections.size === 1 && [...b.connections][0].i2p === a.address, 60000), 'linked to a again')
})
