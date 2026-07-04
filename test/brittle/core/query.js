const test = require('brittle')
const { createGraph } = require('../helpers')

test('query: type() filters entities by type', async (t) => {
  console.log('TEST: query type filter - starting')
  const { graph } = await createGraph(t, 'query-type')

  await graph.put({ type: 'post' })
  await graph.put({ type: 'post' })
  await graph.put({ type: 'user' })

  const posts = await graph.query().type('post').toArray()
  t.is(posts.length, 2, 'type filter matches only posts')
  console.log('TEST: query type filter - passed')
})

test('query: author() filters entities by author', async (t) => {
  console.log('TEST: query author filter - starting')
  const { graph } = await createGraph(t, 'query-author')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.put({ type: 'post' })

  const mine = await graph.query().author(author).toArray()
  t.is(mine.length, 1, 'author filter matches entities from this device')

  const others = await graph.query().author('0'.repeat(64)).toArray()
  t.is(others.length, 0, 'author filter excludes entities from a different author')
  console.log('TEST: query author filter - passed')
})

test('query: tag() filters entities by tag', async (t) => {
  console.log('TEST: query tag filter - starting')
  const { graph } = await createGraph(t, 'query-tag')

  const post1 = await graph.put({ type: 'post' })
  await graph.put({ type: 'post' })
  const ctx = await graph.createContext()
  await graph.tag(post1.id, 'featured', { context: ctx })

  const featured = await graph.query().type('post').tag('featured').toArray()
  t.is(featured.length, 1, 'tag filter narrows results to tagged entities')
  t.is(featured[0].id, post1.id, 'tagged result is the expected post')
  console.log('TEST: query tag filter - passed')
})

test('query: filter() applies a custom predicate', async (t) => {
  console.log('TEST: query custom filter - starting')
  const { graph } = await createGraph(t, 'query-custom-filter')

  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'hello', 'text')

  const matched = await graph.query().type('post').filter(node => node.id === post.id).toArray()
  t.is(matched.length, 1, 'custom filter matches the expected entity')

  const unmatched = await graph.query().type('post').filter(() => false).toArray()
  t.is(unmatched.length, 0, 'custom filter excludes everything when it always returns false')
  console.log('TEST: query custom filter - passed')
})

test('query: out()/in() traverse relations from matched source nodes', async (t) => {
  console.log('TEST: query traversal - starting')
  const { graph } = await createGraph(t, 'query-traversal')

  const post = await graph.put({ type: 'post' })
  const comment1 = await graph.put({ type: 'comment' })
  const comment2 = await graph.put({ type: 'comment' })
  const ctx = await graph.createContext()

  await graph.relate({ from: post.id, to: comment1.id, type: 'reply', context: ctx })
  await graph.relate({ from: post.id, to: comment2.id, type: 'reply', context: ctx })

  console.log('  Step 1: out() traverses outgoing edges from the post')
  const outTraversal = await graph.query().type('post').out('reply').toArray()
  t.is(outTraversal.length, 2, 'out() yields both traversal targets')

  console.log('  Step 2: in() traverses incoming edges into the comments')
  const inTraversal = await graph.query().type('comment').in('reply').toArray()
  t.is(inTraversal.length, 2, 'in() yields both source posts (one per comment)')
  console.log('TEST: query traversal - passed')
})

test('query: limit() caps results, including when combined with traversal', async (t) => {
  console.log('TEST: query limit - starting')
  const { graph } = await createGraph(t, 'query-limit')

  const ctx = await graph.createContext()
  for (let p = 0; p < 3; p++) {
    const post = await graph.put({ type: 'post' })
    for (let i = 0; i < 3; i++) {
      const comment = await graph.put({ type: 'comment' })
      await graph.relate({ from: post.id, to: comment.id, type: 'reply', context: ctx })
    }
  }

  console.log('  Step 1: plain limit on a non-traversal query')
  const limited = await graph.query().type('post').limit(2).toArray()
  t.is(limited.length, 2, 'limit caps a plain type query')

  console.log('  Step 2: limit combined with traversal across multiple source nodes')
  const limitedTraversal = await graph.query().type('post').out('reply').limit(2).toArray()
  t.is(limitedTraversal.length, 2, 'limit caps total traversal results across all matched source nodes')
  console.log('TEST: query limit - passed')
})

test('query: reverse() flips result order', async (t) => {
  console.log('TEST: query reverse - starting')
  const { graph } = await createGraph(t, 'query-reverse')

  const post1 = await graph.put({ type: 'post' })
  const post2 = await graph.put({ type: 'post' })

  const forward = await graph.query().type('post').toArray()
  const reversed = await graph.query().type('post').reverse().toArray()

  t.is(forward.length, 2, 'forward query returns both posts')
  t.is(reversed.length, 2, 'reversed query returns both posts')
  t.alike(reversed.map(n => n.id), forward.map(n => n.id).reverse(), 'reverse() flips the result order')
  console.log('TEST: query reverse - passed')
})

test('query: first() returns only the first match or null', async (t) => {
  console.log('TEST: query first - starting')
  const { graph } = await createGraph(t, 'query-first')

  const emptyFirst = await graph.query().type('post').first()
  t.is(emptyFirst, null, 'first() returns null when nothing matches')

  const post = await graph.put({ type: 'post' })
  const first = await graph.query().type('post').first()
  t.ok(first, 'first() returns a result once one exists')
  t.is(first.id, post.id, 'first() returns the matching entity')
  console.log('TEST: query first - passed')
})

test('query: count() tallies matches without materializing them all', async (t) => {
  console.log('TEST: query count - starting')
  const { graph } = await createGraph(t, 'query-count')

  await graph.put({ type: 'post' })
  await graph.put({ type: 'post' })
  await graph.put({ type: 'user' })

  t.is(await graph.query().type('post').count(), 2, 'count matches the number of posts')
  t.is(await graph.query().type('nonexistent').count(), 0, 'count is 0 for a type nobody used')
  console.log('TEST: query count - passed')
})

test('query: chained filters compose with AND semantics', async (t) => {
  console.log('TEST: query chained filters - starting')
  const { graph } = await createGraph(t, 'query-chained')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  await graph.put({ type: 'post' })
  await graph.put({ type: 'user' })

  const matched = await graph.query().type('post').author(author).toArray()
  t.is(matched.length, 1, 'chaining type + author narrows to entities matching both')
  console.log('TEST: query chained filters - passed')
})

test('queryContext: requires type "moderation", a context, and a target', async (t) => {
  console.log('TEST: queryContext validation - starting')
  const { graph } = await createGraph(t, 'query-context-validation')
  const ctx = await graph.createContext()

  await t.exception(
    (async () => { for await (const _ of graph.queryContext({ type: 'not-moderation', context: ctx, target: 'x' })) { /* noop */ } })(),
    /Unsupported context query type/,
    'rejects an unsupported query type'
  )
  await t.exception(
    (async () => { for await (const _ of graph.queryContext({ type: 'moderation', target: 'x' })) { /* noop */ } })(),
    /Context key is required/,
    'rejects a missing context'
  )
  await t.exception(
    (async () => { for await (const _ of graph.queryContext({ type: 'moderation', context: ctx })) { /* noop */ } })(),
    /Moderation target is required/,
    'rejects a missing target'
  )
  console.log('TEST: queryContext validation - passed')
})
