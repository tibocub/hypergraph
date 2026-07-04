// NOTE ON NETWORK DEPENDENCY: this test joins the real public DHT via
// Hyperswarm to connect two peers. It cannot be verified without real
// network access — run it on a machine with internet access.
//
// Ported from the old ad-hoc `replication-scenarios.js` script (a custom
// main()-based runner that never actually integrated with brittle) into a
// real brittle test.
//
// TEARDOWN ORDERING BUG FOUND & FIXED: brittle's t.teardown() runs LIFO.
// Registering `t.teardown(() => swarmA.destroy())` right after creating the
// swarm — but *after* createGraph() already registered peer a's own
// graph/store-close teardown — meant the swarm was destroyed BEFORE the
// graph/store closed, tearing the raw socket out from under an in-flight
// replication stream mid-shutdown. store.close() then hung forever waiting
// for a clean close event that would never come, deterministically, every
// run. Fixed by consolidating into one teardown per peer that always closes
// graph/store first and destroys the swarm last.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep } = require('../helpers')

test('late-joiner: a peer that joins after data was created still catches up (needs real network)', async (t) => {
  console.log('TEST: catch-up replication - starting (requires DHT access)')

  console.log('  Step 1: peer A announces on the DHT before creating any data')
  const a = await createGraph(t, 'late-joiner-a')
  const localUserCoreOnA = a.store.get({ key: a.graph.key })
  await localUserCoreOnA.ready()

  const topic = a.graph.discoveryKey
  const swarmA = new Hyperswarm()
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  const discA = swarmA.join(topic, { server: true, client: true })
  await discA.flushed()
  await swarmA.flush()

  console.log('  Step 2: peer A creates a message only after being discoverable')
  const msg = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg.id, 'Hello from peer A!', 'text')

  console.log('  Step 3: peer B joins the swarm afterwards and loads peer A user core before replicating')
  const b = await createGraph(t, 'late-joiner-b')
  const remoteUserCoreOnB = b.store.get({ key: a.graph.key })
  await remoteUserCoreOnB.ready()

  const swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discB = swarmB.join(topic, { server: true, client: true })
  await Promise.race([Promise.all([discB.flushed(), swarmB.flush()]), sleep(15000)])

  t.teardown(async () => {
    try { await discA.destroy() } catch (err) { /* already closed */ }
    try { await discB.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    try { await swarmA.destroy() } catch (err) { /* already closed */ }
    try { await swarmB.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  Step 4: pump peer B until it catches up')
  let coreLength = 0
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    await remoteUserCoreOnB.update()
    coreLength = remoteUserCoreOnB.length
    if (coreLength > 0) break
  }

  t.ok(coreLength > 0, `peer B caught up on data created before it joined (core length: ${coreLength})`)
  console.log('TEST: catch-up replication - passed')
})
