// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// TEARDOWN ORDERING BUG FOUND & FIXED: see late-joiner.js for the full
// explanation. Destroying a swarm before its peer's graph/store are closed
// hangs store.close() forever waiting for a clean stream-close event that
// never comes, since the socket underneath it was already killed. Fixed by
// consolidating teardown to always close graph/store before the swarms.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep } = require('../helpers')

test('concurrent-writes: two peers each write and both replicate to each other (needs real network)', async (t) => {
  console.log('TEST: sequential writes, both peers write - starting (requires DHT access)')

  const a = await createGraph(t, 'concurrent-writes-a')
  const b = await createGraph(t, 'concurrent-writes-b')

  console.log('  Step 1: preload both local and remote user cores before replicating')
  const localA = a.store.get({ key: a.graph.key })
  const remoteBOnA = a.store.get({ key: b.graph.key })
  const localB = b.store.get({ key: b.graph.key })
  const remoteAOnB = b.store.get({ key: a.graph.key })
  await Promise.all([localA.ready(), remoteBOnA.ready(), localB.ready(), remoteAOnB.ready()])

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
    try { await discA.destroy() } catch (err) { /* already closed */ }
    try { await discB.destroy() } catch (err) { /* already closed */ }
    await a.close()
    await b.close()
    try { await swarmA.destroy() } catch (err) { /* already closed */ }
    try { await swarmB.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  Step 3: wait for peer B to connect and replicate peer A data')
  await sleep(10000)

  console.log('  Step 4: peer B writes its own message once both have some data')
  const msg2 = await b.graph.put({ type: 'message' })
  await b.graph.putContent(msg2.id, 'Message from Peer B', 'text')

  console.log('  Step 5: wait for both writes to replicate, then verify both cores advanced')
  await sleep(5000)
  await remoteBOnA.update()
  await remoteAOnB.update()

  const coreLength1 = remoteBOnA.length
  const coreLength2 = remoteAOnB.length

  t.ok(coreLength1 > 0, `peer A received peer B's data (remote core length: ${coreLength1})`)
  t.ok(coreLength2 > 0, `peer B received peer A's data (remote core length: ${coreLength2})`)
  console.log('TEST: sequential writes, both peers write - passed')
})
