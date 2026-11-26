// The DHT inside I2P, over the SAM stand-in (no router): a destination announced by one node is found by a
// client-only node that knows only the bootstrap node; forged and stale records are dropped; a client-only node
// stores nothing.

const test = require('brittle')
const b4a = require('b4a')
const c = require('compact-encoding')
const sodium = require('sodium-universal')
const { I2PDHT, ANNOUNCE, LOOKUP, record: encoding } = require('../../../lib/i2p/dht.js')
const { standIn } = require('./_sam.js')

/** @param {string} s */
const topicOf = (s) => { const out = b4a.alloc(32); sodium.crypto_generichash(out, b4a.from(s)); return out }

test('i2p dht: loads no udx-native, hyperswarm or hyperdht', (t) => {
  // Bare lists a module a require() in some function names, unrun (exports null): only those that ran count.
  const loaded = Object.keys(require.cache).filter((f) => /[\\/]node_modules[\\/](udx-native|hyperswarm|hyperdht)[\\/]/.test(f) && require.cache[f].exports !== null)
  t.alike(loaded, [])
})

async function network (t, n, opts = {}) {
  const router = await standIn(opts)
  const sam = { port: router.port }
  const nodes = []
  t.teardown(async () => { await Promise.all(nodes.map((d) => d.destroy())); await router.close() }, { order: 10 })
  const boot = await I2PDHT.open({ sam, ephemeral: false, firewalled: false })
  nodes.push(boot)
  await boot.ready()
  for (let i = 0; i < n; i++) {
    const d = await I2PDHT.open({ sam, bootstrap: [boot.bootstrapAddress], ephemeral: false, firewalled: false })
    nodes.push(d)
    await d.ready()
  }
  const add = async (o) => {
    const d = await I2PDHT.open({ sam, bootstrap: [boot.bootstrapAddress], ...o })
    nodes.push(d)
    await d.ready()
    return d
  }
  return { router, sam, boot, nodes, add }
}

test('i2p dht: a client-only node finds a destination announced elsewhere, through the bootstrap node alone', async (t) => {
  const { nodes, add } = await network(t, 8)
  const topic = topicOf('a forum')
  await nodes[5].announce(topic)
  const client = await add({ ephemeral: true })
  const early = []
  let ended = false
  const found = await client.lookup(topic, { onfound: (f) => early.push({ address: f.address, ended }) }).finally(() => { ended = true })
  t.alike(found.map((f) => f.address), [nodes[5].identity.address], 'the announcer, and only it')
  t.alike(early, [{ address: nodes[5].identity.address, ended: false }], 'given as soon as found, before the lookup ended')
  t.alike(found[0].dest, nodes[5].identity.dest, 'its full destination, to dial')
  t.is(client.stored.size, 0, 'the client-only node stores nothing')
  t.alike(await client.lookup(topicOf('another forum')), [], 'nothing for a topic no one announced')
})

test('i2p dht: two announcers, one lookup; an announcer does not find itself', async (t) => {
  const { nodes } = await network(t, 6)
  const topic = topicOf('a site')
  await nodes[1].announce(topic)
  await nodes[4].announce(topic)
  const got = (await nodes[1].lookup(topic)).map((f) => f.address)
  t.alike(got, [nodes[4].identity.address])
  const all = (await nodes[2].lookup(topic)).map((f) => f.address).sort()
  t.alike(all, [nodes[1].identity.address, nodes[4].identity.address].sort())
})

test('i2p dht: forged, stale and other-topic records are not stored or returned', async (t) => {
  const { nodes, boot } = await network(t, 4)
  const topic = topicOf('a board')
  const me = nodes[2]
  const time = Math.floor(Date.now() / 1000)
  const sign = (tp, tm) => {
    const s = b4a.alloc(64)
    sodium.crypto_sign_detached(s, b4a.concat([b4a.from('hypergraph/i2p-announce'), tp, c.encode(c.uint, tm)]), me.identity.keyPair.secretKey)
    return s
  }
  const record = (r) => c.encode(encoding, r)
  const forged = record({ dest: nodes[3].identity.dest, time, signature: sign(topic, time) }) // signed by another key
  const stale = record({ dest: me.identity.dest, time: time - 3600, signature: sign(topic, time - 3600) })
  const wrongTopic = record({ dest: me.identity.dest, time, signature: sign(topicOf('elsewhere'), time) })
  const to = { host: boot.identity.address, port: 1 }
  for (const value of [forged, stale, wrongTopic]) {
    const first = await me.dht.request({ target: topic, command: ANNOUNCE, value }, to)
    await me.dht.request({ token: first.token, target: topic, command: ANNOUNCE, value }, to)
  }
  const reply = await me.dht.request({ target: topic, command: LOOKUP }, to)
  t.is(reply.value, null, 'the bootstrap node kept none of them')
  t.alike(await nodes[1].lookup(topic), [])
})

test('i2p dht: still found with 15 % of datagrams lost', { timeout: 120000 }, async (t) => {
  const { nodes, add } = await network(t, 2, { loss: 0.15 })
  const topic = topicOf('lossy')
  await nodes[2].announce(topic)
  const client = await add({ ephemeral: true })
  const found = await client.lookup(topic)
  t.ok(found.some((f) => f.address === nodes[2].identity.address), 'found despite the loss')
})

test('sam: a datagram goes out in one write (i2pd drops one whose data comes in a later read)', async (t) => {
  const router = await standIn()
  const s = await require('../../../lib/i2p/sam.js').session({ sam: { port: router.port } })
  t.teardown(async () => { s.close(); await router.close() })
  const writes = []
  const write = s.socket.socket.write.bind(s.socket.socket)
  s.socket.socket.write = (chunk) => { writes.push(chunk); return write(chunk) }
  s.send(s.identity.address, b4a.from('hello'))
  t.is(writes.length, 1)
  t.ok(b4a.toString(writes[0]).endsWith('SIZE=5\nhello'))
})

test('i2p dht: three nodes are enough (an I2P address is known at once: no waiting for peers to report it)', async (t) => {
  const { nodes, add } = await network(t, 1)
  const topic = topicOf('small')
  await nodes[1].announce(topic)
  const client = await add({ ephemeral: true })
  t.alike((await client.lookup(topic)).map((f) => f.address), [nodes[1].identity.address])
})
