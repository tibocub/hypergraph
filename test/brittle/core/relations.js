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
