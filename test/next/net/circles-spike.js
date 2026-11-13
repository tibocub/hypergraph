// Spec 023, R1: a spike. A holder is a BlindPeer inside an instance (the
// instance's own store and swarm); a member's trusted client hands it a
// private space's cores; with the member offline, an outsider member of that
// space finds the holder on the space's topic and reads from it.

const test = require('brittle')
const path = require('path')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const BlindPeer = require('blind-peer')
const BlindPeering = require('blind-peering')
const forum = require('../forum/forum.js')
const testing = require('../../../lib/testing.js')
const { account } = require('../forum/_setup.js')
const { eventually, bounded } = require('../helpers.js')

async function holds (store, key, length) {
  const core = store.get({ key })
  await core.ready()
  const ok = core.length >= length && length > 0 && await core.has(0, length)
  await core.close()
  return ok
}

test('spike: in-instance blind peer serves a private space to an outsider member while its owner is away', { timeout: 180000 }, async (t) => {
  const a = await account(t, 'a')
  const h = await account(t, 'h') // the holder, a circle member, not in the space
  const c = await account(t, 'c') // in the space, not in the circle
  const fa = await forum.createForum(a, 'Kept-5150', { private: true })
  const fc = await forum.join(c, await forum.invite(fa))
  t.ok(await eventually(async () => (await forum.latest(fc)).length === 0, 5000), 'c joined')
  await c.close()

  // the holder: a BlindPeer on h's store and swarm, its records in its own folder
  const client = crypto.keyPair() // a's holding client key: not its swarm key (one connection per key)
  const swarm = h._network.swarm
  const bp = new BlindPeer(path.join(h.dir, 'holding'), { swarm, store: h.store, wakeup: h._network.wakeup, trustedPubKeys: [client.publicKey] })
  const topics = new Set()
  bp.on('add-cores-received', (stream, req) => {
    if (!req.referrer) return
    const id = b4a.toString(req.referrer, 'hex')
    if (topics.has(id)) return
    topics.add(id)
    swarm.join(crypto.discoveryKey(req.referrer), { server: true, client: false })
  })
  await bp.ready()
  await swarm.listen()
  t.teardown(() => bounded(bp.close(), 10000, 'bp.close()'), { order: -1 })

  await forum.post(fa, 'while-c-away-1', 'secret-5150')
  await forum.post(fa, 'while-c-away-2', 'secret-5150')

  const peering = new BlindPeering(a._network.swarm.dht, a.store, { keys: [swarm.keyPair.publicKey], wakeup: a._network.wakeup, pick: 50 })
  peering.keyPair = client
  t.teardown(() => peering.close(), { order: -1 })
  const keys = [...(await testing.coreKeys(fa)).values()]
  const cores = []
  const t0 = Date.now()
  for (const key of keys) {
    const core = a.store.get({ key })
    await core.ready()
    cores.push(core)
  }
  await Promise.all(cores.map((core) => peering.addCore(core, { referrer: fa.keyBytes, announce: false })))
  t.ok(await eventually(async () => {
    for (const core of cores) if (core.length && !(await holds(h.store, core.key, core.length))) return false
    return true
  }, 30000), 'h holds every core')
  t.comment(`handed ${cores.length} cores in ${Date.now() - t0} ms`)
  t.ok(topics.has(b4a.toString(fa.keyBytes, 'hex')), 'h joined the space topic')
  for (const core of cores) await core.close()
  await peering.close()
  await a.close()

  const t1 = Date.now()
  const c2 = await account(t, 'c2', { dir: c.dir })
  const fc2 = c2.space(fa.key)
  const titles = async () => (await forum.latest(fc2)).map((p) => p.title).sort().join()
  t.ok(await eventually(async () => (await titles()) === 'while-c-away-1,while-c-away-2', 60000), 'c reads them from h alone')
  t.comment(`c read a's latest from h in ${Date.now() - t1} ms`)
  t.absent(testing.inClear(await testing.rawBlocks(h.store, keys), 'secret-5150'), 'nothing readable on h')
})
