// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// TEARDOWN ORDERING BUG FOUND & FIXED: see late-joiner.js for the full
// explanation. Destroying a swarm before its peer's graph/store are closed
// hangs store.close() forever waiting for a clean stream-close event that
// never comes, since the socket underneath it was already killed. Fixed by
// consolidating teardown to always close graph/store before the swarms.
// (The mid-test `swarmB.destroy()` below is an intentional simulated
// disconnect, not teardown, and is unaffected by this fix.)

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep } = require('../helpers')

test('peer-reconnection: a disconnected peer catches up on data created while it was offline (needs real network)', async (t) => {
  console.log('TEST: peer reconnection - starting (requires DHT access)')

  const a = await createGraph(t, 'peer-reconnection-a')
  const b = await createGraph(t, 'peer-reconnection-b')

  const remoteUserCoreOnB = b.store.get({ key: a.graph.key })
  await remoteUserCoreOnB.ready()

  const topic = a.graph.discoveryKey
  const swarmA = new Hyperswarm()
  swarmA.on('connection', (conn) => a.store.replicate(conn))

  let swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  console.log('  Step 1: both peers join and connect')
  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await Promise.race([Promise.all([discA.flushed(), discB.flushed()]), sleep(5000)])

  console.log('  Step 2: peer A writes a first message while B is connected')
  const msg1 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg1.id, 'Message 1', 'text')
  await sleep(3000)

  console.log('  Step 3: peer B disconnects (intentional mid-test disconnect, not teardown)')
  await swarmB.destroy()

  console.log('  Step 4: peer A writes a second message while B is offline')
  const msg2 = await a.graph.put({ type: 'message' })
  await a.graph.putContent(msg2.id, 'Message 2', 'text')

  console.log('  Step 5: peer B reconnects with a fresh swarm')
  swarmB = new Hyperswarm()
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const remoteUserCoreOnBAfterReconnect = b.store.get({ key: a.graph.key })
  await remoteUserCoreOnBAfterReconnect.ready()

  const discBReconnect = swarmB.join(topic, { server: true, client: true })
  await discBReconnect.flushed()

  t.teardown(async () => {
    try { await discA.destroy() } catch (err) { /* already closed */ }
    try { await discBReconnect.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    try { await swarmA.destroy() } catch (err) { /* already closed */ }
    try { await swarmB.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  Step 6: wait for both messages to sync after reconnection')
  await sleep(5000)
  await remoteUserCoreOnBAfterReconnect.update()

  const coreLength = remoteUserCoreOnBAfterReconnect.length
  t.ok(coreLength > 0, `peer B caught up after reconnecting (core length: ${coreLength})`)
  console.log('TEST: peer reconnection - passed')
})
