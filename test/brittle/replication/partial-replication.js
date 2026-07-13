// NOTE ON NETWORK DEPENDENCY: joins the real public DHT via Hyperswarm.
// Cannot be verified without real network access.
//
// WHAT "PARTIAL REPLICATION" ACTUALLY MEANS HERE (verified against source,
// not assumed):
//
// There is no way to replicate only *some* entities out of a user core, or
// only *some* events out of a context — Hypercore/Autobase replication is
// all-or-nothing per core. What IS "partial" is which cores/contexts a peer
// chooses to open and track at all:
//   - A peer that never calls openUserCore(X) or openContext(Y) has zero
//     knowledge of X or Y's data, ever.
//   - A peer that opens one but not the other only receives that one.
// This test verifies exactly that: the peer opens contextA but not
// contextB, and only ever receives contextA's data.
//
// BUG FOUND & FIXED: the previous version of this test used a raw
// `peer.store.get({ key: owner.graph.key })` to watch the owner's user
// core. That only creates a Hypercore reference for replication — it does
// NOT register the core with the graph's view (confirmed by reading
// `getByTag()`'s source: it cross-references each tagged entity via
// `this.getNode(entityId)`, which only reads from the graph's own view,
// which is only populated by cores opened via `openUserCore()`). So the
// peer's raw bytes for the owner's entities were replicating fine, but
// `getByTag()` could never resolve them, and the test waited forever for
// something that could never happen — nothing to do with the network or
// with addWriter(). Verified with a local (non-DHT) probe: a peer that
// opens a context WITHOUT ever being added as a writer, but DOES use
// `openUserCore()` for the referenced entity's core, sees tagged data
// correctly. Fixed by using `openUserCore()` here too.

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, waitForConnections } = require('../helpers')

test('partial-replication: a peer only receives data for contexts it has opened (needs real network)', { timeout: 480000 }, async (t) => {
  console.log('TEST: partial replication over real network - starting (requires DHT access)')

  console.log('  Step 1: owner creates two separate contexts with tagged, content-bearing entities in each')
  const owner = await createGraph(t, 'partial-repl-owner')

  const contextA = await owner.graph.createContext({ writeMode: 'open' })
  const contextB = await owner.graph.createContext({ writeMode: 'open' })

  const postA = await owner.graph.put({ type: 'post' })
  await owner.graph.putContent(postA.id, 'Content A: visible once contextA is opened', 'text')
  await owner.graph.tag(postA.id, 'in-context-a', { context: contextA })

  const postB = await owner.graph.put({ type: 'post' })
  await owner.graph.putContent(postB.id, 'Content B: visible once contextB is opened', 'text')
  await owner.graph.tag(postB.id, 'in-context-b', { context: contextB })

  console.log('  Step 2: peer opens only contextA (not contextB) before connecting, and registers the owner user core properly')
  const peer = await createGraph(t, 'partial-repl-peer')
  await peer.graph.openContext(contextA, { writeMode: 'open' })
  // Deliberately NOT opening contextB yet.

  // openUserCore() (not a raw store.get()) is what actually registers the
  // owner's core with the peer's graph view — required for graph.get()/
  // getByTag()'s entity cross-reference to ever resolve. See file header.
  const ownerUserCore = await peer.graph.openUserCore(owner.graph.key)

  const topic = owner.graph.discoveryKey
  const swarmOwner = new Hyperswarm()
  const swarmPeer = new Hyperswarm()
  swarmOwner.on('connection', (conn) => owner.store.replicate(conn))
  swarmPeer.on('connection', (conn) => peer.store.replicate(conn))

  const discOwner = swarmOwner.join(topic, { server: true, client: true })
  const discPeer = swarmPeer.join(topic, { server: true, client: true })
  await Promise.all([discOwner.flushed(), discPeer.flushed()])
  // discovery.flushed() only confirms the DHT announce/lookup round
  // finished — swarm.flush() is what actually drains the connection queue
  // and waits for the resulting connection attempts to complete.
  await Promise.all([swarmOwner.flush(), swarmPeer.flush()])

  t.teardown(async () => {
    try { await discOwner.destroy() } catch (err) { /* already closed */ }
    try { await discPeer.destroy() } catch (err) { /* already closed */ }
    await owner.close()
    await peer.close()
    try { await swarmOwner.destroy() } catch (err) { /* already closed */ }
    try { await swarmPeer.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  Step 2b: verify a real connection exists (not just flushed discovery) before pumping')
  const connCounts = await waitForConnections([{ name: 'owner', swarm: swarmOwner }, { name: 'peer', swarm: swarmPeer }], 60000, { topic, retries: 2 })
  const hasConnection = connCounts.every((c) => c.count > 0)
  t.ok(hasConnection, 'both peers have at least one live connection')

  if (!hasConnection) {
    // No point burning the rest of the time budget on three more pump loops
    // that have no path to converge — this is a real connectivity failure
    // (DHT/NAT), not something a longer wait would fix.
    console.log('TEST: partial replication over real network - skipped remaining steps (no connection)')
    return
  }

  console.log('  Step 3: pump the peer until the owner user core (entities) has fully replicated')
  for (let i = 0; i < 60; i++) {
    await sleep(1000)
    await ownerUserCore.update()
    if (ownerUserCore.length > 0) break
  }
  t.ok(ownerUserCore.length > 0, 'peer replicated the owner user core (raw entity data)')

  console.log('  Step 3b: verify entity replication is exact — both posts and their exact content, regardless of context')
  let bothEntitiesReplicated = false
  let replicatedPostA = null
  let replicatedPostB = null
  let replicatedContentA = null
  let replicatedContentB = null
  for (let i = 0; i < 30; i++) {
    await sleep(1000)
    await peer.graph.update()
    replicatedPostA = await peer.graph.get(postA.id)
    replicatedPostB = await peer.graph.get(postB.id)
    if (replicatedPostA && replicatedPostB) {
      replicatedContentA = await peer.graph.getContent(postA.id)
      replicatedContentB = await peer.graph.getContent(postB.id)
      bothEntitiesReplicated = true
      break
    }
  }
  t.ok(bothEntitiesReplicated, 'both entities replicated via the fully-replicated user core, regardless of which context they belong to')
  t.is(replicatedPostA.id, postA.id, 'postA id matches exactly')
  t.is(replicatedPostB.id, postB.id, 'postB id matches exactly')
  t.ok(replicatedContentA, 'postA content replicated')
  t.is(replicatedContentA.body, 'Content A: visible once contextA is opened', 'postA content body matches exactly what was written, not just "something" non-empty')
  t.ok(replicatedContentB, 'postB content replicated')
  t.is(replicatedContentB.body, 'Content B: visible once contextB is opened', 'postB content body matches exactly what was written, not just "something" non-empty')

  // NOTE: entity data (raw user core) and context data (a separate Autobase
  // per context) replicate independently and don't converge at the same
  // rate — context/Autobase sync involves extra round trips (system core,
  // then writer cores, then view materialization) on top of the DHT
  // connection itself. So step 4 below needs its own retry loop rather than
  // a single snapshot check right after step 3's loop exits.
  console.log('  Step 4: pump the peer until contextA\'s tag is visible (contextB should stay invisible)')
  let taggedAResult = []
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    await peer.graph.update()
    taggedAResult = []
    for await (const n of peer.graph.getByTag('in-context-a')) taggedAResult.push(n)
    if (taggedAResult.length === 1) break
    if (i % 10 === 0) console.log(`    ...waiting (${i}s): contextA tag not visible yet`)
  }
  t.is(taggedAResult.length, 1, 'peer eventually sees exactly one tagged entity from the context it opened')
  if (taggedAResult.length === 1) {
    t.is(taggedAResult[0].id, postA.id, 'the tagged entity is exactly postA, not some other entity')
  }

  const taggedB = []
  for await (const n of peer.graph.getByTag('in-context-b')) taggedB.push(n)
  t.is(taggedB.length, 0, 'peer does not see the tag from the context it has not opened yet, even though it already has postB\'s raw entity data')

  console.log('  Step 5: peer opens contextB and eventually catches up on it too')
  await peer.graph.openContext(contextB, { writeMode: 'open' })

  let taggedBAfter = []
  for (let i = 0; i < 90; i++) {
    await sleep(1000)
    await peer.graph.update()
    taggedBAfter = []
    for await (const n of peer.graph.getByTag('in-context-b')) taggedBAfter.push(n)
    if (taggedBAfter.length === 1) break
    if (i % 10 === 0) console.log(`    ...waiting (${i}s): contextB tag not visible yet`)
  }
  t.is(taggedBAfter.length, 1, 'peer catches up on contextB once it opens it')
  if (taggedBAfter.length === 1) {
    t.is(taggedBAfter[0].id, postB.id, 'the newly-visible tagged entity is exactly postB')
  }
  console.log('TEST: partial replication over real network - passed')
})
