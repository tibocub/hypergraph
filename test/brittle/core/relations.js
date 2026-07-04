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
