// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// TEARDOWN HANG FIX: no longer calls discX.destroy() separately in
// teardown. destroySwarm() (used below) explicitly destroys active connections, then skips
// Hyperswarm's graceful discovery-session cleanup, which is what would
// otherwise call discX.destroy() internally anyway — and that path can
// invoke an unannounce() network call with no visible internal timeout.
// See test/brittle/networking/peer-connection.js for the fuller
// investigation.
//
// TEARDOWN ORDERING BUG FOUND & FIXED: see late-joiner.js for the full
// explanation. Destroying a swarm before its peer's graph/store are closed
// hangs store.close() forever waiting for a clean stream-close event that
// never comes, since the socket underneath it was already killed. Fixed by
// consolidating teardown to always close graph/store before the swarms.
//
// BUG FIX: this used to watch remote user cores via a raw `store.get()`,
// which only creates a Hypercore reference for replication — it never
// registers the core with the graph's view, so graph.get()/getContent()
// could never see the remote peer's data (confirmed: openUserCore()
// explicitly calls view.addUserCore(); a raw store.get() never does).
// This only mattered once we started checking actual content instead of
// just raw core length — length alone doesn't prove the *right* data
// replicated, only that *some* bytes did.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, destroySwarm } = require('../helpers')

test('concurrent-writes: two peers each write, both replicate, and content matches exactly (needs real network)', async (t) => {
  console.log('TEST: sequential writes, both peers write - starting (requires DHT access)')

  const a = await createGraph(t, 'concurrent-writes-a')
  const b = await createGraph(t, 'concurrent-writes-b')

  console.log('  Step 1: preload both remote user cores before replicating (via openUserCore, not raw store.get)')
  const bUserCoreOnA = await a.graph.openUserCore(b.graph.key)
  const aUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = new Hyperswarm()
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  const discA = swarmA.join(topic, { server: true, client: true })
  await discA.flushed()

  console.log('  Step 2: peer A writes first, then peer B joins')
  const msg1 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg1.id, 'Message from Peer A', 'text')

  const swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discB = swarmB.join(topic, { server: true, client: true })
  await discB.flushed()

  t.teardown(async () => {
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 3: wait for peer B to connect and replicate peer A data')
  await sleep(10000)

  console.log('  Step 4: peer B writes its own message once both have some data')
  const msg2 = await b.graph.put({ type: 'message' })
  await b.graph.putContent(msg2.id, 'Message from Peer B', 'text')

  console.log('  Step 5: wait for both writes to replicate, then verify exact content matches on both sides')
  let msg2OnA = null
  let msg1OnB = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    await bUserCoreOnA.update()
    await aUserCoreOnB.update()
    await a.graph.update()
    await b.graph.update()
    msg2OnA = await a.graph.get(msg2.id)
    msg1OnB = await b.graph.get(msg1.id)
    if (msg2OnA && msg1OnB) break
  }

  t.ok(msg2OnA, `peer A received peer B's message entity`)
  t.ok(msg1OnB, `peer B received peer A's message entity`)

  const msg2ContentOnA = msg2OnA ? await a.graph.getContent(msg2.id) : null
  const msg1ContentOnB = msg1OnB ? await b.graph.getContent(msg1.id) : null
  t.is(msg2ContentOnA && msg2ContentOnA.body, 'Message from Peer B', "peer A's copy of peer B's message matches exactly")
  t.is(msg1ContentOnB && msg1ContentOnB.body, 'Message from Peer A', "peer B's copy of peer A's message matches exactly")
  console.log('TEST: sequential writes, both peers write - passed')
})
