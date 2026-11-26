// A forum with an anonymous member (I2P only), over a stand-in for the I2P router. Bob, its owner, uses both networks
// (dual stack, as every regular identity does), Carl the regular network only, Ana I2P only: Ana finds the board in
// the DHT inside I2P (no helper), Bob lets her in, and posts reach Carl through Bob's replication, never through a
// link between Carl and Ana. Two dual-stack people keep their Hyperswarm link. A helper that listens on I2P too
// keeps what Ana posts.

const test = require('brittle')
const path = require('path')
const z32 = require('z32')
const b4a = require('b4a')
const Hyperswarm = require('hyperswarm')
const forum = require('./forum.js')
const { account } = require('./_setup.js')
const { heldBy } = require('../net/_helper.js')
const { standIn } = require('../net/_sam.js')
const { I2PSwarm, DualSwarm } = require('../../../lib/i2p/swarm.js')
const { I2PDHT } = require('../../../lib/i2p/dht.js')
const { eventually, tmpDir, testBootstrap, bounded } = require('../helpers.js')

async function i2p (t) {
  const router = await standIn()
  const boot = await I2PDHT.open({ sam: { port: router.port }, ephemeral: false, firewalled: false })
  await boot.ready()
  t.teardown(async () => { await boot.destroy(); await router.close() }, { order: 10 })
  return { port: router.port, bootstrap: [boot.bootstrapAddress] }
}

const titles = async (f) => (await forum.latest(f)).map((p) => p.title)

test('i2p: an anonymous member finds a board with no helper, is let in over I2P, and posts cross to the regular network', { timeout: 180000 }, async (t) => {
  const sam = await i2p(t)
  const bob = await account(t, 'bob', { transport: 'dual', sam })
  const carl = await account(t, 'carl')
  const ana = await account(t, 'ana', { transport: 'i2p', sam })
  const fb = await forum.createForum(bob, 'Board')
  const fc = await forum.join(carl, await forum.invite(fb))
  const fa = await forum.join(ana, await forum.invite(fb), { timeout: 60000 })
  t.pass('ana joined over I2P, found in the DHT inside I2P')

  await forum.post(fa, 'From ana', 'hello')
  t.ok(await eventually(async () => (await titles(fc)).includes('From ana'), 60000), 'carl reads ana\'s post (through bob)')
  await forum.post(fc, 'From carl', 'hi')
  t.ok(await eventually(async () => (await titles(fa)).includes('From carl'), 60000), 'ana reads carl\'s post (through bob)')

  const anaKey = ana._network.keyPair.publicKey
  t.absent([...carl._network.connections].some((c) => b4a.equals(c.remotePublicKey, anaKey)), 'carl never linked to ana')
  t.ok([...ana._network.connections].every((c) => c.i2p), 'ana\'s links are all over I2P')
  t.absent([...carl._network.connections].some((c) => c.i2p), 'carl\'s links are all regular')
})

test('i2p: two dual-stack people keep their regular link', { timeout: 120000 }, async (t) => {
  const sam = await i2p(t)
  const bob = await account(t, 'bob', { transport: 'dual', sam })
  const dan = await account(t, 'dan', { transport: 'dual', sam })
  const fb = await forum.createForum(bob, 'Board')
  await forum.join(dan, await forum.invite(fb))
  await forum.post(fb, 'x', 'y')
  await new Promise((resolve) => setTimeout(resolve, 3000)) // both sides looked over I2P too
  const links = [...bob._network.connections].filter((c) => b4a.equals(c.remotePublicKey, dan._network.keyPair.publicKey))
  t.is(links.length, 1, 'one link')
  t.absent(links[0].i2p, 'the regular one')
})

test('i2p: a helper listening on I2P too keeps an anonymous member\'s posts', { timeout: 180000 }, async (t) => {
  const sam = await i2p(t)
  const BlindPeer = require('blind-peer')
  const hyperswarm = new Hyperswarm({ bootstrap: await testBootstrap(t) })
  const dual = new DualSwarm(hyperswarm)
  dual.attach(await I2PSwarm.open({ sam, keyPair: hyperswarm.keyPair, bootstrap: sam.bootstrap, full: true, announceKey: true }))
  const vps = new BlindPeer(path.join(tmpDir(t, 'helper'), 'store'), { swarm: dual })
  await vps.ready()
  await vps.listen()
  t.teardown(async () => { await bounded(vps.close(), 10000, 'helper.close()'); await dual.destroy() }, { order: 0 })

  const ana = await account(t, 'ana', { transport: 'i2p', sam })
  const fa = await forum.createForum(ana, 'Notes')
  await forum.setHelpers(fa, [z32.encode(vps.publicKey)])
  await forum.post(fa, 'kept', 'while away')
  t.ok(await eventually(() => heldBy(vps, fa), 60000), 'the helper holds ana\'s board, reached over I2P')
})
