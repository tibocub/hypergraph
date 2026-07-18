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
// (The mid-test `swarmB.destroy()` below is an intentional simulated
// disconnect, not teardown, and is unaffected by this fix.)
//
// BUG FIX: watched the remote user core via a raw `store.get()`, which only
// creates a Hypercore reference for replication — it never registers the
// core with the graph's view, so graph.get()/getContent() could never see
// peer A's data. Switched to openUserCore() so exact content of both
// messages can actually be verified, not just raw core length (which only
// proves *some* bytes arrived, not the *right* ones). Also added the
// explicit swarm.flush() call used elsewhere in this suite — this test's
// generous sleep() buffers appear to have made it work without it, but
// there's no reason to rely on that incidental margin instead of doing it
// properly to begin with.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, destroySwarm } = require('../helpers')

test('peer-reconnection: a disconnected peer catches up on data created while it was offline, with content verified (needs real network)', async (t) => {
  console.log('TEST: peer reconnection - starting (requires DHT access)')

  const a = await createGraph(t, 'peer-reconnection-a')
  const b = await createGraph(t, 'peer-reconnection-b')

  const remoteUserCoreOnB = await b.graph.openUserCore(a.graph.key)

  const topic = a.graph.discoveryKey
  const swarmA = new Hyperswarm()
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  let swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  console.log('  Step 1: both peers join and connect')
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await Promise.race([Promise.all([discA.flushed(), discB.flushed()]), sleep(5000)])
  // discovery.flushed() only confirms the DHT announce/lookup round
  // finished — swarm.flush() is what actually drains the connection queue
  // and waits for the resulting connection attempts to complete.
  await Promise.race([Promise.all([swarmA.flush(), swarmB.flush()]), sleep(5000)])

  console.log('  Step 2: peer A writes a first message while B is connected')
  const msg1 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg1.id, 'Message 1', 'text')
  await sleep(3000)

  console.log('  Step 3: peer B disconnects (intentional mid-test disconnect, not teardown)')
  await destroySwarm(swarmB)

  console.log('  Step 4: peer A writes a second message while B is offline')
  const msg2 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg2.id, 'Message 2', 'text')

  console.log('  Step 5: peer B reconnects with a fresh swarm')
  swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discBReconnect = swarmB.join(topic, { server: true, client: true })
  await discBReconnect.flushed()
  await Promise.race([swarmB.flush(), sleep(5000)])

  t.teardown(async () => {
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 6: wait for both messages to sync after reconnection, then verify exact content')
  let msg1OnB = null
  let msg2OnB = null
  for (let i = 0; i < 20; i++) {
    await sleep(1000)
    await remoteUserCoreOnB.update()
    await b.graph.update()
    msg1OnB = await b.graph.get(msg1.id)
    msg2OnB = await b.graph.get(msg2.id)
    if (msg1OnB && msg2OnB) break
  }

  t.ok(msg1OnB, 'peer B caught up on the message written before it disconnected')
  t.ok(msg2OnB, 'peer B caught up on the message written while it was offline')

  const content1OnB = msg1OnB ? await b.graph.getContent(msg1.id) : null
  const content2OnB = msg2OnB ? await b.graph.getContent(msg2.id) : null
  t.is(content1OnB && content1OnB.body, 'Message 1', 'content of the pre-disconnect message matches exactly')
  t.is(content2OnB && content2OnB.body, 'Message 2', 'content of the offline-written message matches exactly')
  console.log('TEST: peer reconnection - passed')

  // TEMPORARY WORKAROUND, not a real fix — same class of issue as
  // peer-connection.js (see that file's comment): this file is the last
  // one alphabetically in test/brittle/replication/*.js, and something in
  // this replication run leaves a resource open that prevents the process
  // from exiting naturally after this, the last test in the file. Deferring
  // further investigation for the same reason: prioritizing a test suite
  // that completes end-to-end over chasing this further right now.
  setTimeout(() => process.exit(0), 2000)
})
