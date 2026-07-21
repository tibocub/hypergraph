const test = require('brittle')
const { createGraph, sleep } = require('../helpers')

test('relations: relate creates a directed edge visible in both directions', async (t) => {
  console.log('TEST: relate basic - starting')
  const { graph } = await createGraph(t, 'relations-basic')

  console.log('  Step 1: create entities and a context')
  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const context = await graph.createContext()

  console.log('  Step 2: relate comment -> post as reply')
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })

  console.log('  Step 3: verify outgoing edge on comment')
  const outEdges = []
  for await (const e of graph.edges(comment.id, { direction: 'out' })) outEdges.push(e)
  t.is(outEdges.length, 1, 'comment has one outgoing edge')
  t.is(outEdges[0].type, 'reply', 'outgoing edge type is reply')
  t.is(outEdges[0].to, post.id, 'outgoing edge points to the post')

  console.log('  Step 4: verify incoming edge on post')
  const inEdges = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) inEdges.push(e)
  t.is(inEdges.length, 1, 'post has one incoming reply edge')
  t.is(inEdges[0].from, comment.id, 'incoming edge originates from the comment')
  console.log('TEST: relate basic - passed')
})

test('relations: relating the same triple twice does not duplicate the live edge', async (t) => {
  console.log('TEST: relate idempotency - starting')
  const { graph } = await createGraph(t, 'relations-idempotent')

  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const context = await graph.createContext()

  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })

  const outEdges = []
  for await (const e of graph.edges(comment.id, { direction: 'out' })) outEdges.push(e)
  t.is(outEdges.length, 1, 'duplicate relate calls do not create a second live edge')
  console.log('TEST: relate idempotency - passed')
})

test('relations: unrelate removes the edge', async (t) => {
  console.log('TEST: unrelate - starting')
  const { graph } = await createGraph(t, 'relations-unrelate')

  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const context = await graph.createContext()

  console.log('  Step 1: relate then confirm counts')
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })
  t.is(await graph.countEdgesIn(post.id, 'reply'), 1, 'post has 1 incoming reply before unrelate')
  t.is(await graph.countEdgesOut(comment.id, 'reply'), 1, 'comment has 1 outgoing reply before unrelate')

  console.log('  Step 2: unrelate')
  await graph.unrelate({ from: comment.id, to: post.id, type: 'reply', context })

  console.log('  Step 3: confirm counts drop to zero')
  t.is(await graph.countEdgesIn(post.id, 'reply'), 0, 'post has 0 incoming reply after unrelate')
  t.is(await graph.countEdgesOut(comment.id, 'reply'), 0, 'comment has 0 outgoing reply after unrelate')
  console.log('TEST: unrelate - passed')
})

test('relations: edges direction and type filters narrow results correctly', async (t) => {
  console.log('TEST: edges filters - starting')
  const { graph } = await createGraph(t, 'relations-filters')

  const post = await graph.put({ type: 'post' })
  const commentA = await graph.put({ type: 'comment' })
  const commentB = await graph.put({ type: 'comment' })
  const context = await graph.createContext()

  await graph.relate({ from: commentA.id, to: post.id, type: 'reply', context })
  await graph.relate({ from: commentB.id, to: post.id, type: 'like', context })

  const replies = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) replies.push(e)
  t.is(replies.length, 1, 'type filter only returns reply edges')

  const allIncoming = []
  for await (const e of graph.edges(post.id, { direction: 'in' })) allIncoming.push(e)
  t.is(allIncoming.length, 2, 'omitting type filter returns all incoming edges')
  console.log('TEST: edges filters - passed')
})

test('relations: edge ordering (asc/desc) and limit', async (t) => {
  console.log('TEST: edge ordering - starting')
  const { graph } = await createGraph(t, 'relations-ordering')

  console.log('  Step 1: create a post and three comments replying to it')
  const post = await graph.put({ type: 'post' })
  const c1 = await graph.put({ type: 'comment' })
  const c2 = await graph.put({ type: 'comment' })
  const c3 = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await graph.relate({ from: c1.id, to: post.id, type: 'reply', context: ctx })
  await sleep(2)
  await graph.relate({ from: c2.id, to: post.id, type: 'reply', context: ctx })
  await sleep(2)
  await graph.relate({ from: c3.id, to: post.id, type: 'reply', context: ctx })

  console.log('  Step 2: verify ascending order')
  const inAsc = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply', order: 'asc' })) inAsc.push(e)
  t.is(inAsc.length, 3, 'all three replies returned')
  t.ok(inAsc[0].createdAt <= inAsc[1].createdAt, 'first <= second in ascending order')
  t.ok(inAsc[1].createdAt <= inAsc[2].createdAt, 'second <= third in ascending order')

  console.log('  Step 3: verify descending order with limit')
  const inDescLimit2 = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply', order: 'desc', limit: 2 })) inDescLimit2.push(e)
  t.is(inDescLimit2.length, 2, 'limit caps results to 2')
  t.ok(inDescLimit2[0].createdAt >= inDescLimit2[1].createdAt, 'descending order holds')
  t.is(inDescLimit2[0].from, c3.id, 'most recent reply (c3) is first in desc order')

  console.log('  Step 4: verify outgoing edges respect order + limit too')
  const outDescLimit1 = []
  for await (const e of graph.edges(c1.id, { direction: 'out', type: 'reply', order: 'desc', limit: 1 })) outDescLimit1.push(e)
  t.is(outDescLimit1.length, 1, 'limit 1 returns a single edge')
  t.is(outDescLimit1[0].to, post.id, 'edge points to the post')
  console.log('TEST: edge ordering - passed')
})

test('relations: countEdgesIn/countEdgesOut reflect current edge counts', async (t) => {
  console.log('TEST: edge counts - starting')
  const { graph } = await createGraph(t, 'relations-counts')

  const post = await graph.put({ type: 'post' })
  const c1 = await graph.put({ type: 'comment' })
  const c2 = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await graph.relate({ from: c1.id, to: post.id, type: 'reply', context: ctx })
  await graph.relate({ from: c2.id, to: post.id, type: 'reply', context: ctx })

  t.is(await graph.countEdgesIn(post.id, 'reply'), 2, 'post has 2 incoming replies')
  t.is(await graph.countEdgesOut(c1.id, 'reply'), 1, 'c1 has 1 outgoing reply')
  t.is(await graph.countEdgesIn(post.id, 'like'), 0, 'post has 0 incoming likes')
  console.log('TEST: edge counts - passed')
})

test('relations: relate() accepts an optional numeric value, retrievable via edges()', async (t) => {
  console.log('TEST: relation value - starting')
  const { graph } = await createGraph(t, 'relations-value')

  const post = await graph.put({ type: 'post' })
  const voteNode = await graph.put({ type: 'vote' })
  const ctx = await graph.createContext()

  const event = await graph.relate({ from: voteNode.id, to: post.id, type: 'vote', value: -1, context: ctx })
  t.is(event.value, -1, 'the returned event includes the value')

  const edges = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'vote' })) edges.push(e)
  t.is(edges.length, 1, 'one vote edge exists')
  t.is(edges[0].value, -1, 'value is retrievable via edges()')

  console.log('  a relation with no value at all still works, value is simply absent')
  const like = await graph.put({ type: 'like' })
  const likeEvent = await graph.relate({ from: like.id, to: post.id, type: 'like', context: ctx })
  t.absent('value' in likeEvent && likeEvent.value !== undefined, 'no value field when not provided')
  console.log('TEST: relation value - passed')
})

test('relations: relate() rejects a non-numeric value', async (t) => {
  console.log('TEST: relation value validation - starting')
  const { graph } = await createGraph(t, 'relations-value-validation')

  const post = await graph.put({ type: 'post' })
  const voteNode = await graph.put({ type: 'vote' })
  const ctx = await graph.createContext()

  await t.exception(
    graph.relate({ from: voteNode.id, to: post.id, type: 'vote', value: 'up', context: ctx }),
    /opts\.value must be a finite number/,
    'rejects a string value'
  )
  await t.exception(
    graph.relate({ from: voteNode.id, to: post.id, type: 'vote', value: NaN, context: ctx }),
    /opts\.value must be a finite number/,
    'rejects NaN'
  )
  await t.exception(
    graph.relate({ from: voteNode.id, to: post.id, type: 'vote', value: Infinity, context: ctx }),
    /opts\.value must be a finite number/,
    'rejects Infinity'
  )
  console.log('TEST: relation value validation - passed')
})

test('relations: a relation\'s value is part of its signed digest — tampering with it fails verification', async (t) => {
  console.log('TEST: relation value signature integrity - starting')
  const { graph } = await createGraph(t, 'relations-value-signature')

  const post = await graph.put({ type: 'post' })
  const voteNode = await graph.put({ type: 'vote' })
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)

  const event = await graph.relate({ from: voteNode.id, to: post.id, type: 'vote', value: 1, context: ctx })

  console.log('  appending a forged copy with a different value but the ORIGINAL signature')
  const forged = { ...event, value: 1000000 }
  await context.append(forged)
  await graph.update()

  const edges = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'vote' })) edges.push(e)
  t.is(edges.length, 1, 'only the original, correctly-signed vote was indexed — the forged one was rejected')
  t.is(edges[0].value, 1, 'the indexed value is the original, untampered one')
  console.log('TEST: relation value signature integrity - passed')
})

test('relations: latestPerAuthor reduces multiple edges from the same author to just their most recent one', async (t) => {
  console.log('TEST: latestPerAuthor - starting')
  const voterA = await createGraph(t, 'relations-latest-voter-a')
  const voterB = await createGraph(t, 'relations-latest-voter-b')

  const post = await voterA.graph.put({ type: 'post' })
  const ctx = await voterA.graph.createContext({ writeMode: 'open' })
  const aCtx = await voterA.graph.openContext(ctx, { writeMode: 'open' })
  const bCtx = await voterB.graph.openContext(ctx, { writeMode: 'open' })
  await aCtx.addWriter(bCtx.localKey)

  const s1 = voterA.store.replicate(true, { live: true })
  const s2 = voterB.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  for (let i = 0; i < 20 && !bCtx.writable; i++) { await sleep(200); await bCtx.update() }
  t.ok(bCtx.writable, 'voterB is confirmed writable before voting')

  // voterA votes, then changes their mind and votes again — same author,
  // two different nodes (no built-in uniqueness constraint stops this).
  const vote1 = await voterA.graph.put({ type: 'vote' })
  await voterA.graph.relate({ from: vote1.id, to: post.id, type: 'vote', value: 1, context: ctx })
  await sleep(10)
  const vote2 = await voterA.graph.put({ type: 'vote' })
  await voterA.graph.relate({ from: vote2.id, to: post.id, type: 'vote', value: -1, context: ctx })

  // voterB casts a single, separate vote.
  const vote3 = await voterB.graph.put({ type: 'vote' })
  await voterB.graph.relate({ from: vote3.id, to: post.id, type: 'vote', value: 1, context: ctx })

  for (let i = 0; i < 20; i++) {
    await sleep(200)
    await voterA.graph.update()
    const edges = []
    for await (const e of voterA.graph.edges(post.id, { direction: 'in', type: 'vote' })) edges.push(e)
    if (edges.length === 3) break
  }

  const allEdges = []
  for await (const e of voterA.graph.edges(post.id, { direction: 'in', type: 'vote' })) allEdges.push(e)
  t.is(allEdges.length, 3, 'sanity check: all 3 raw vote edges are visible without reduction')

  const reduced = []
  for await (const e of voterA.graph.edges(post.id, { direction: 'in', type: 'vote', latestPerAuthor: true })) reduced.push(e)

  const aPubkey = voterA.graph.identity.deviceKeyPair.publicKey.toString('hex')
  const bPubkey = voterB.graph.identity.deviceKeyPair.publicKey.toString('hex')
  const byAuthor = Object.fromEntries(reduced.map(e => [e.author, e.value]))

  t.is(reduced.length, 2, 'reduced to one edge per distinct author (2 authors voted)')
  t.is(byAuthor[aPubkey], -1, "voterA's LATEST vote (-1, the second one) is the one that counts, not their first")
  t.is(byAuthor[bPubkey], 1, "voterB's single vote is counted correctly")
  console.log('TEST: latestPerAuthor - passed')
})

test('relations: a relation/create event encoded before the value field existed still decodes without crashing', async (t) => {
  // REGRESSION TEST — hit in a real deployment: existing, already-persisted
  // relation/create events (encoded before the value field was added) have
  // no trailing bytes for it at all. The decoder used to unconditionally
  // try to read them, throwing "Out of bounds" the moment such an event
  // was replayed from disk (confirmed directly: this crashed a real
  // running app on startup). Manually constructs an old-format buffer —
  // the same shape the encoder produced before this field existed — to
  // verify decodeEvent() handles it gracefully rather than relying on
  // some current app happening to have old-enough data lying around.
  console.log('TEST: relation value backward compat - starting')
  const c = require('compact-encoding')
  const b4a = require('b4a')
  const { EVENT_TYPES, decodeEvent } = require('../../../src/encodings/event.js')

  const event = {
    type: 'relation/create',
    timestamp: Date.now(),
    from: 'a',
    to: 'b',
    relationType: 'reply',
    author: 'someauthor',
    signature: 'ab'.repeat(32)
  }

  const state = c.state()
  c.uint.preencode(state, EVENT_TYPES[event.type])
  c.uint.preencode(state, event.timestamp)
  c.string.preencode(state, event.from)
  c.string.preencode(state, event.to)
  c.string.preencode(state, event.relationType)
  c.string.preencode(state, event.author)
  c.buffer.preencode(state, b4a.from(event.signature, 'hex'))
  // Deliberately no value bytes at all — matches the pre-value-field format.

  state.buffer = b4a.allocUnsafe(state.end)
  c.uint.encode(state, EVENT_TYPES[event.type])
  c.uint.encode(state, event.timestamp)
  c.string.encode(state, event.from)
  c.string.encode(state, event.to)
  c.string.encode(state, event.relationType)
  c.string.encode(state, event.author)
  c.buffer.encode(state, b4a.from(event.signature, 'hex'))

  let decoded = null
  let threw = null
  try {
    decoded = decodeEvent(state.buffer)
  } catch (err) {
    threw = err
  }

  t.absent(threw, 'decoding an old-format event (no value bytes) does not throw')
  t.is(decoded.from, 'a', 'from field decodes correctly')
  t.is(decoded.signature, 'ab'.repeat(32), 'signature decodes correctly')
  t.absent(decoded.value, 'value is simply undefined for an old-format event, not a crash')
  console.log('TEST: relation value backward compat - passed')
})

test('relations: unrelate() removes an edge — it stops appearing in edges(), counts, and cannot be double-deleted', async (t) => {
  console.log('TEST: unrelate basic - starting')
  const { graph } = await createGraph(t, 'unrelate-basic')

  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context: ctx })

  const before = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) before.push(e)
  t.is(before.length, 1, 'the relation exists before unrelate')
  t.is(await graph.countEdgesIn(post.id, 'reply'), 1, 'count is 1 before unrelate')

  console.log('  Step: unrelate it')
  await graph.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctx })

  const after = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) after.push(e)
  t.is(after.length, 0, 'the relation no longer appears in edges() after unrelate')
  t.is(await graph.countEdgesIn(post.id, 'reply'), 0, 'count correctly drops to 0')
  t.is(await graph.countEdgesOut(comment.id, 'reply'), 0, 'outgoing count correctly drops to 0 too')

  console.log('  Step: calling unrelate() again on the same, already-deleted relation throws rather than silently no-op-ing')
  await t.exception(
    graph.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctx }),
    /Relation not found/,
    'double-unrelate throws — there is nothing left to delete'
  )
  console.log('TEST: unrelate basic - passed')
})

test('relations: unrelate() on a relation that never existed throws, not a silent no-op', async (t) => {
  console.log('TEST: unrelate nonexistent - starting')
  const { graph } = await createGraph(t, 'unrelate-nonexistent')
  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await t.exception(
    graph.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctx }),
    /Relation not found/,
    'unrelate on a relation that was never created throws'
  )
  console.log('TEST: unrelate nonexistent - passed')
})

test('relations: after unrelate(), relate()-ing the exact same from/to/type again recreates the edge correctly', async (t) => {
  console.log('TEST: unrelate then re-relate - starting')
  const { graph } = await createGraph(t, 'unrelate-rerelate')
  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await graph.relate({ from: comment.id, to: post.id, type: 'reply', value: 1, context: ctx })
  await graph.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctx })

  console.log('  relate the same from/to/type again, with a different value this time')
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', value: 2, context: ctx })

  const edges = []
  for await (const e of graph.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
  t.is(edges.length, 1, 'exactly one edge exists — the deleted one did not linger alongside the new one')
  t.is(edges[0].value, 2, 'and it is the NEW relation (value 2), not a resurrected old one')
  t.is(await graph.countEdgesIn(post.id, 'reply'), 1, 'count correctly reflects one active edge, not accumulated from both the deleted and recreated relation')
  console.log('TEST: unrelate then re-relate - passed')
})

test('relations: any authorized writer can unrelate a relation, not just whoever originally created it — same permissive model as relate()', async (t) => {
  console.log('TEST: unrelate by a different writer - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirA = path.join(os.tmpdir(), `hypergraph-unrelate-writer-a-${process.pid}-${Date.now()}`)
  const storeA = new Corestore(dirA)
  const graphA = new Hypergraph(storeA)
  await graphA.ready()

  const dirB = path.join(os.tmpdir(), `hypergraph-unrelate-writer-b-${process.pid}-${Date.now()}`)
  const storeB = new Corestore(dirB)
  const graphB = new Hypergraph(storeB)
  await graphB.ready()

  t.teardown(async () => {
    await graphA.close()
    await graphB.close()
    await storeA.close()
    await storeB.close()
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  const post = await graphA.put({ type: 'post' })
  const comment = await graphA.put({ type: 'comment' })
  const ctxKey = await graphA.createContext({ writeMode: 'open' })
  const ctxA = await graphA.openContext(ctxKey, { writeMode: 'open' })

  await graphB.openUserCore(graphA.key)
  const ctxB = await graphB.openContext(ctxKey, { writeMode: 'open' })

  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  await ctxA.addWriter(ctxB.localKey)
  await graphA.relate({ from: comment.id, to: post.id, type: 'reply', context: ctxKey })

  console.log('  B waits to become a writer and see the relation replicate')
  for (let i = 0; i < 40 && !ctxB.writable; i++) { await sleep(200); await ctxB.update() }
  t.ok(ctxB.writable, 'B is confirmed writable before attempting to unrelate')

  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphB.update()
    const edges = []
    for await (const e of graphB.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
    if (edges.length > 0) break
  }

  console.log('  B (who did not create this relation) unrelates it')
  await graphB.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctxKey })

  let removed = false
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphA.update()
    const remaining = []
    for await (const e of graphA.edges(post.id, { direction: 'in', type: 'reply' })) remaining.push(e)
    if (remaining.length === 0) { removed = true; break }
  }
  t.ok(removed, 'B successfully removed a relation A created — same permissive, no-ownership-check model as relate() itself')
  console.log('TEST: unrelate by a different writer - passed')
})

test('relations: an unrelate() propagates correctly to other peers over real replication', async (t) => {
  console.log('TEST: unrelate cross-peer replication - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirA = path.join(os.tmpdir(), `hypergraph-unrelate-repl-a-${process.pid}-${Date.now()}`)
  const storeA = new Corestore(dirA)
  const graphA = new Hypergraph(storeA)
  await graphA.ready()

  const dirB = path.join(os.tmpdir(), `hypergraph-unrelate-repl-b-${process.pid}-${Date.now()}`)
  const storeB = new Corestore(dirB)
  const graphB = new Hypergraph(storeB)
  await graphB.ready()

  t.teardown(async () => {
    await graphA.close()
    await graphB.close()
    await storeA.close()
    await storeB.close()
    fs.rmSync(dirA, { recursive: true, force: true })
    fs.rmSync(dirB, { recursive: true, force: true })
  })

  const post = await graphA.put({ type: 'post' })
  const comment = await graphA.put({ type: 'comment' })
  const ctxKey = await graphA.createContext({ writeMode: 'open' })
  const ctxA = await graphA.openContext(ctxKey, { writeMode: 'open' })
  await graphA.relate({ from: comment.id, to: post.id, type: 'reply', context: ctxKey })

  await graphB.openUserCore(graphA.key)
  const ctxB = await graphB.openContext(ctxKey, { writeMode: 'open' })

  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  B waits to see the original relation replicate first')
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphB.update()
    const edges = []
    for await (const e of graphB.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
    if (edges.length > 0) break
  }
  const beforeB = []
  for await (const e of graphB.edges(post.id, { direction: 'in', type: 'reply' })) beforeB.push(e)
  t.is(beforeB.length, 1, 'B sees the relation before it is deleted')

  console.log('  A unrelates it; B should see it disappear after replicating')
  await graphA.unrelate({ from: comment.id, to: post.id, type: 'reply', context: ctxKey })

  let sawDeleted = false
  for (let i = 0; i < 30; i++) {
    await sleep(200)
    await graphB.update()
    const edges = []
    for await (const e of graphB.edges(post.id, { direction: 'in', type: 'reply' })) edges.push(e)
    if (edges.length === 0) { sawDeleted = true; break }
  }
  t.ok(sawDeleted, 'B correctly sees the relation disappear once the delete replicates')
  console.log('TEST: unrelate cross-peer replication - passed')
})

