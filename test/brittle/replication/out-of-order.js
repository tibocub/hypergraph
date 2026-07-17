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
// This complements test/brittle/forum/scenarios/out-of-order-replication.js
// and reply-before-parent.js, which already cover out-of-order moderation
// and relation events over *local* (non-network) replication pipes. This
// test exercises the same "relate before the referenced entity has
// replicated" pattern, but over a real Hyperswarm/DHT connection, to catch
// anything that only surfaces with real network timing/latency.
//
// Teardown always closes graph/store before destroying swarms (see
// late-joiner.js for the full explanation of why order matters here).

const test = require('brittle')
const Hyperswarm = require('hyperswarm')
const { createGraph, sleep, waitForConnections, destroySwarm } = require('../helpers')

test('out-of-order: a relation referencing a not-yet-replicated entity still converges correctly (needs real network)', { timeout: 340000 }, async (t) => {
  console.log('TEST: out-of-order replication over real network - starting (requires DHT access)')

  console.log('  Step 1: peer A creates a post but deliberately does NOT connect yet')
  const a = await createGraph(t, 'out-of-order-a')
  const post = await a.graph.put({ type: 'post' })
  await a.graph.putContent(post.id, 'Original post', 'text')

  console.log('  Step 2: peer B creates a comment relating to that post before ever seeing it')
  const b = await createGraph(t, 'out-of-order-b')
  const context = await b.graph.createContext({ writeMode: 'open' })
  const comment = await b.graph.put({ type: 'comment' })
  await b.graph.putContent(comment.id, 'Reply to a post I have not synced yet', 'text')
  await b.graph.relate({ from: comment.id, to: post.id, type: 'reply', context })

  console.log('  Step 3: peer A opens the same context and both connect over the DHT afterward')
  await a.graph.openContext(context, { writeMode: 'open' })

  // IMPORTANT: use openUserCore(), not a raw store.get(). A raw store.get()
  // only creates a Hypercore reference for replication — it never registers
  // the core with the graph's view, so graph.get()/graph.update() would
  // never see B's comment no matter how long this waited or how good the
  // connection was. openUserCore() calls view.addUserCore() internally,
  // which is what actually wires a remote core's events into the
  // materialized, queryable graph state.
  const remoteBUserCore = await a.graph.openUserCore(b.graph.key)
  const remoteAOnB = b.store.get({ key: a.graph.key })
  await remoteAOnB.ready()

  const topic = a.graph.discoveryKey
  const swarmA = new Hyperswarm()
  const swarmB = new Hyperswarm()
  swarmA.on('connection', (conn) => a.store.replicate(conn))
  swarmB.on('connection', (conn) => b.store.replicate(conn))

  const discA = swarmA.join(topic, { server: true, client: true })
  const discB = swarmB.join(topic, { server: true, client: true })
  await Promise.all([discA.flushed(), discB.flushed()])
  // discovery.flushed() only confirms the DHT announce/lookup round
  // finished — swarm.flush() is what actually drains the connection queue
  // and waits for the resulting connection attempts to complete.
  await Promise.all([swarmA.flush(), swarmB.flush()])

  t.teardown(async () => {
    await a.close()
    await b.close()
    await destroySwarm(swarmA)
    await destroySwarm(swarmB)
  })

  console.log('  Step 3b: verify a real connection exists (not just flushed discovery) before pumping')
  const connCounts = await waitForConnections([{ name: 'A', swarm: swarmA }, { name: 'B', swarm: swarmB }], 60000, { topic, retries: 2 })
  const hasConnection = connCounts.every((c) => c.count > 0)
  t.ok(hasConnection, 'both peers have at least one live connection')

  if (!hasConnection) {
    // No point burning the rest of the time budget pumping for data that
    // has no path to arrive on — this is a real connectivity failure
    // (DHT/NAT), not something a longer wait would fix. Fail fast instead
    // of also timing out the whole test process.
    console.log('TEST: out-of-order replication over real network - skipped remaining steps (no connection)')
    return
  }

  console.log('  Step 4: pump peer A until both the comment and the reply relation are visible')
  let converged = false
  let commentSeenAt = null
  let matchingEdge = null
  for (let i = 0; i < 110; i++) {
    await sleep(1000)
    await remoteBUserCore.update()
    await a.graph.update()

    const commentNode = await a.graph.get(comment.id)
    if (!commentNode) {
      if (i % 10 === 0) console.log(`    ...waiting (${i}s): comment entity not replicated yet`)
      continue
    }
    if (commentSeenAt === null) {
      commentSeenAt = i
      console.log(`    comment entity replicated at ~${i}s, now waiting on the context/relation to converge`)
    }

    const inbound = []
    for await (const edge of a.graph.view.getEdges(post.id, { direction: 'in', type: 'reply' })) inbound.push(edge)
    matchingEdge = inbound.find((e) => e.from === comment.id) || null
    if (matchingEdge) {
      converged = true
      break
    }
    if (i % 10 === 0) console.log(`    ...waiting (${i}s): comment replicated, relation not visible yet`)
  }

  t.ok(converged, 'the relation referencing a not-yet-replicated entity converged once both peers synced')
  t.ok(matchingEdge, 'the specific reply edge from the comment to the post is present, not just some edge')
  if (matchingEdge) {
    t.is(matchingEdge.from, comment.id, 'edge "from" is exactly the comment id')
    t.is(matchingEdge.to, post.id, 'edge "to" is exactly the post id')
    t.is(matchingEdge.type, 'reply', 'edge type is exactly "reply"')
  }

  const commentContent = await a.graph.getContent(comment.id)
  t.ok(commentContent, "peer A replicated the comment's content, not just its metadata")
  t.is(commentContent && commentContent.body, 'Reply to a post I have not synced yet', "the comment's content matches exactly what peer B wrote")
  console.log('TEST: out-of-order replication over real network - passed')
})
