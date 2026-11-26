// transport: 'i2p' over the SAM stand-in (no router): the options are checked; two I2P-only people share a forum
// (invite, join, posts both ways); adding a device is refused; and after all that, nothing of Hyperswarm, HyperDHT,
// udx-native or blind-pairing was ever loaded. The DHT inside I2P starts from one full node, as a helper would be.

const test = require('brittle')
const forum = require('../forum/forum.js')
const { Hypergraph } = require('../../../lib/index.js')
const { I2PDHT } = require('../../../lib/i2p/dht.js')
const { standIn } = require('./_sam.js')
const { tmpDir, eventually, codeOf, bounded } = require('../helpers.js')

async function i2p (t) {
  const router = await standIn()
  const boot = await I2PDHT.open({ sam: { port: router.port }, ephemeral: false, firewalled: false })
  await boot.ready()
  t.teardown(async () => { await boot.destroy(); await router.close() }, { order: 10 })
  return { port: router.port, bootstrap: [boot.bootstrapAddress] }
}

async function person (t, label, sam) {
  const events = []
  const hg = await Hypergraph.open(tmpDir(t, label), { types: forum.types, rules: forum.rules, transport: 'i2p', sam, ontransport: (e) => events.push(e) })
  t.teardown(() => bounded(hg.close(), 15000, label + '.close()'), { order: 0 })
  t.alike(events.map((e) => e.state), ['connecting', 'ready'], label + ': told it was connecting, then ready, while open() waited')
  await hg.connectToSwarm()
  return hg
}

test('transport: the options are checked', async (t) => {
  await t.exception.all(Hypergraph.open(tmpDir(t, 'x'), { transport: 'tor' }), /transport is one of normal, dual, i2p/)
  await t.exception.all(Hypergraph.open(tmpDir(t, 'y'), { transport: 'i2p' }), /needs sam/)
  await t.exception.all(Hypergraph.open(tmpDir(t, 'z'), { transport: 'dual', sam: { port: 0 } }), /needs sam/)
  t.is(await codeOf(Hypergraph.open(tmpDir(t, 'w'), { transport: 'i2p', sam: { port: 1 }, joinCode: 'x' })), 'NOT_ALLOWED', 'no device pairing over I2P')
})

test('transport i2p: two people share a forum over I2P only; no device added; no UDP code loaded; loopback only', { timeout: 120000 }, async (t) => {
  // Every TCP socket opened from here on, by anything in this process: only the router's SAM, on 127.0.0.1.
  const net = require('net')
  const hosts = new Set()
  const connect = net.connect
  net.connect = net.createConnection = function (...args) {
    const o = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' }
    hosts.add(o.path ? 'pipe' : (o.host || 'localhost'))
    return connect.apply(this, args)
  }
  t.teardown(() => { net.connect = net.createConnection = connect })
  const sam = await i2p(t)
  const ana = await person(t, 'ana', sam)
  const eve = await person(t, 'eve', sam)
  const fa = await forum.createForum(ana, 'Quiet board')
  await forum.post(fa, 'First', 'from ana')
  const fe = await forum.join(eve, await forum.invite(fa))
  t.ok(await eventually(async () => (await forum.latest(fe)).some((p) => p.title === 'First'), 30000), 'eve reads ana\'s post')
  await forum.post(fe, 'Reply', 'from eve')
  t.ok(await eventually(async () => (await forum.latest(fa)).some((p) => p.title === 'Reply'), 30000), 'ana reads eve\'s')
  t.is(await codeOf(ana.addDevice()), 'NOT_ALLOWED', 'addDevice refused over I2P')
  t.ok(ana.i2pNodes().length >= 1, 'it knows DHT nodes to start from next time')
  await ana.close()
  await eve.close()
  // Bare lists a module a require() in some function names, unrun (exports null): only those that ran count.
  const loaded = Object.keys(require.cache).filter((f) => /[\\/]node_modules[\\/](hyperswarm|hyperdht|udx-native|blind-pairing)[\\/]/.test(f) && require.cache[f].exports !== null)
  t.alike(loaded, [], 'none of them loaded')
  t.alike([...hosts], ['127.0.0.1'], 'every socket went to 127.0.0.1') // UDP: none, udx-native never loaded
  t.absent(Object.keys(require.cache).some((f) => /[\\/]node_modules[\\/]bare-dgram[\\/]/.test(f)))
})
