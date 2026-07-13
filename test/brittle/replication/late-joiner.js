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
//
// BUG FIX: watched the remote user core via a raw `store.get()`, which only
// creates a Hypercore reference for replication — it never registers the
// core with the graph's view, so graph.get()/getContent() could never see
// peer A's data. Switched to openUserCore() so exact content can actually
// be verified, not just raw core length (which only proves *some* bytes
// arrived, not the *right* ones).

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep } = require('../helpers')

test('late-joiner: a peer that joins after data was created still catches up, with content verified (needs real network)', async (t) => {
  console.log('TEST: catch-up replication - starting (requires DHT access)')

  console.log('  Step 1: peer A announces on the DHT before creating any data')
  const a = await createGraph(t, 'late-joiner-a')

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
  const remoteUserCoreOnB = await b.graph.openUserCore(a.graph.key)

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

  console.log('  Step 4: pump peer B until it catches up, then verify the exact content matches')
  let msgOnB = null
  for (let i = 0; i < 30; i++) {
    await sleep(500)
    await remoteUserCoreOnB.update()
    await b.graph.update()
    msgOnB = await b.graph.get(msg.id)
    if (msgOnB) break
  }

  t.ok(msgOnB, 'peer B caught up on the entity created before it joined')
  const contentOnB = msgOnB ? await b.graph.getContent(msg.id) : null
  t.is(contentOnB && contentOnB.body, 'Hello from peer A!', "peer B's copy of the content matches exactly what peer A wrote")
  console.log('TEST: catch-up replication - passed')
})
