const test = require('brittle')
const { createGraph, sleep } = require('../helpers')

test('query: default order is chronological even across multiple authors', async (t) => {
  // REGRESSION TEST — confirmed empirically before this fix that the
  // default order was NOT chronological once more than one author was
  // involved: entity IDs are `type/authorCoreKeyHex/seq`, and the old
  // default scan just followed that key's lexicographic order, meaning a
  // newer post from one author could sort before an older post from
  // another purely because of how their core keys happened to compare.
  console.log('TEST: query chronological order across authors - starting')

  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const { Hypergraph } = require('../../../index.js')

  // Two separate identities sharing one Corestore — no network
  // replication needed, since both cores physically live in the same
  // store, so opening the other's user core is immediate.
  const dir = path.join(os.tmpdir(), `hypergraph-query-order-${process.pid}-${Date.now()}`)
  const store = new Corestore(dir)
  const graphA = new Hypergraph(store)
  await graphA.ready()
  const graphB = new Hypergraph(store, { seed: require('hypercore-crypto').randomBytes(32) })
  await graphB.ready()
  t.teardown(async () => {
    try { await graphA.close() } catch {}
    try { await graphB.close() } catch {}
    try { await store.close() } catch {}
  })

  await graphA.openUserCore(graphB.key)

  // Create posts in a specific, known chronological order, alternating
  // authors, regardless of how their core keys happen to sort.
  const first = await graphA.put({ type: 'post' })
  await sleep(10)
  const second = await graphB.put({ type: 'post' })
  await sleep(10)
  const third = await graphA.put({ type: 'post' })

  await graphA.update()

  const ordered = await graphA.query().type('post').toArray()
  t.alike(
    ordered.map(p => p.id),
    [first.id, second.id, third.id],
    'type-filtered query returns entities in actual creation order, not key order'
  )

  const orderedNoTypeFilter = await graphA.query().toArray()
  t.alike(
    orderedNoTypeFilter.map(p => p.id),
    [first.id, second.id, third.id],
    'unfiltered query also returns entities in actual creation order'
  )
  console.log('TEST: query chronological order across authors - passed')
})

test('query: sortBy() sorts by an arbitrary field, including derived ones not stored on the entity', async (t) => {
  console.log('TEST: query sortBy - starting')
  const { graph } = await createGraph(t, 'query-sortby')

  const postA = await graph.put({ type: 'post' })
  const postB = await graph.put({ type: 'post' })
  const postC = await graph.put({ type: 'post' })
  const ctx = await graph.createContext()

  // Simulate a derived "vote count" via relations, exactly like
  // p2p-reddit-clone does — this field never exists on the stored entity
  // itself, so sortBy() has to work from a value attached at query time,
  // not an index.
  const voteCounts = { [postA.id]: 5, [postB.id]: 1, [postC.id]: 10 }
  for (const p of [postA, postB, postC]) {
    for (let i = 0; i < voteCounts[p.id]; i++) {
      const voteNode = await graph.put({ type: 'vote' })
      await graph.relate({ from: voteNode.id, to: p.id, type: 'vote', context: ctx })
    }
  }

  // .filter() as an enrichment step: attach the derived voteCount onto
  // each node (always returning true, so nothing is actually excluded)
  // before sortBy() sorts on it.
  const results = await graph.query()
    .type('post')
    .filter(async (node) => {
      let count = 0
      for await (const _e of graph.edges(node.id, { direction: 'in', type: 'vote' })) count++
      node.voteCount = count
      return true
    })
    .sortBy('voteCount', 'desc')
    .toArray()

  t.alike(results.map(r => r.id), [postC.id, postA.id, postB.id], 'sorted by descending vote count: C (10), A (5), B (1)')

  const asc = await graph.query()
    .type('post')
    .filter(async (node) => {
      let count = 0
      for await (const _e of graph.edges(node.id, { direction: 'in', type: 'vote' })) count++
      node.voteCount = count
      return true
    })
    .sortBy('voteCount', 'asc')
    .limit(2)
    .toArray()
  t.alike(asc.map(r => r.id), [postB.id, postA.id], 'ascending + limit(2) applies the limit AFTER sorting, not before')

  console.log('TEST: query sortBy - passed')
})

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

test('query: live() fires immediately with the initial snapshot, then again after a local write', async (t) => {
  console.log('TEST: live basic - starting')
  const { graph } = await createGraph(t, 'query-live-basic')

  const calls = []
  const unsubscribe = graph.query().type('post').live((results) => {
    calls.push(results.map(r => r.id))
  })
  t.teardown(() => unsubscribe())

  for (let i = 0; i < 20 && calls.length < 1; i++) await sleep(50)
  t.is(calls.length, 1, 'fires once immediately with the initial (empty) snapshot')
  t.alike(calls[0], [], 'initial snapshot is empty — no posts yet')

  const post = await graph.put({ type: 'post' })

  for (let i = 0; i < 40 && calls.length < 2; i++) await sleep(50)
  t.is(calls.length, 2, 'fires again after a local write')
  t.alike(calls[1], [post.id], 'the second callback reflects the new post')
  console.log('TEST: live basic - passed')
})

test('query: live() debounces a burst of changes into a single re-run', async (t) => {
  console.log('TEST: live debounce - starting')
  const { graph } = await createGraph(t, 'query-live-debounce')

  const calls = []
  const unsubscribe = graph.query().type('post').live((results) => {
    calls.push(results.length)
  }, { debounceMs: 100 })
  t.teardown(() => unsubscribe())

  for (let i = 0; i < 20 && calls.length < 1; i++) await sleep(50)
  t.is(calls.length, 1, 'initial snapshot fired')

  console.log('  three rapid writes in quick succession, well within the debounce window')
  await graph.put({ type: 'post' })
  await graph.put({ type: 'post' })
  await graph.put({ type: 'post' })

  // Wait well past the debounce window, then check nothing further has
  // fired beyond one coalesced re-run.
  await sleep(400)
  t.is(calls.length, 2, 'three rapid changes coalesced into exactly one re-run, not three')
  t.is(calls[1], 3, 'and that one re-run reflects all three writes')
  console.log('TEST: live debounce - passed')
})

test('query: live()\'s unsubscribe function stops future callbacks', async (t) => {
  console.log('TEST: live unsubscribe - starting')
  const { graph } = await createGraph(t, 'query-live-unsub')

  const calls = []
  const unsubscribe = graph.query().type('post').live((results) => {
    calls.push(results.length)
  })

  for (let i = 0; i < 20 && calls.length < 1; i++) await sleep(50)
  t.is(calls.length, 1, 'initial snapshot fired')

  unsubscribe()

  await graph.put({ type: 'post' })
  await sleep(300)
  t.is(calls.length, 1, 'no further callbacks after unsubscribing, even though a matching write happened')
  console.log('TEST: live unsubscribe - passed')
})

test('query: live()\'s callback throwing does not break the subscription for future changes', async (t) => {
  console.log('TEST: live callback error resilience - starting')
  const { graph } = await createGraph(t, 'query-live-error')

  let callCount = 0
  const seenLengths = []
  const unsubscribe = graph.query().type('post').live((results) => {
    callCount++
    seenLengths.push(results.length)
    if (callCount === 1) throw new Error('deliberate callback failure on the first call')
  })
  t.teardown(() => unsubscribe())

  for (let i = 0; i < 20 && callCount < 1; i++) await sleep(50)
  t.is(callCount, 1, 'initial call happened (and threw)')

  await graph.put({ type: 'post' })
  for (let i = 0; i < 40 && callCount < 2; i++) await sleep(50)
  t.is(callCount, 2, 'a later change still triggers a callback despite the earlier one throwing')
  t.is(seenLengths[1], 1, 'and it reflects the new post correctly')
  console.log('TEST: live callback error resilience - passed')
})

test('query: live() re-runs when data arrives via REPLICATION, not just local writes — the actual point of this feature', async (t) => {
  console.log('TEST: live cross-peer replication - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const fs = require('fs')
  const { Hypergraph } = require('../../../index.js')

  const dirA = path.join(os.tmpdir(), `hypergraph-live-a-${process.pid}-${Date.now()}`)
  const storeA = new Corestore(dirA)
  const graphA = new Hypergraph(storeA)
  await graphA.ready()

  const dirB = path.join(os.tmpdir(), `hypergraph-live-b-${process.pid}-${Date.now()}`)
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

  // B watches for posts, but never writes any itself — every post B sees
  // must have arrived via replication from A.
  const calls = []
  const unsubscribe = graphB.query().type('post').live((results) => {
    calls.push(results.map(r => r.id))
  })
  t.teardown(() => unsubscribe())

  for (let i = 0; i < 20 && calls.length < 1; i++) await sleep(50)
  t.is(calls.length, 1, 'initial snapshot fired on B (empty)')

  await graphB.openUserCore(graphA.key)

  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => {
    try { s1.destroy() } catch (err) { /* already closed */ }
    try { s2.destroy() } catch (err) { /* already closed */ }
  })

  console.log('  A creates a post; B should see its live query re-fire from replicated data alone')
  const post = await graphA.put({ type: 'post' })

  // B's own update() loop needs to actually run for replicated data to be
  // processed and the 'change' event to fire — a real app would be
  // calling update() periodically (e.g. an SSE poll loop); simulate that
  // here rather than relying on any automatic background sync.
  let sawIt = false
  for (let i = 0; i < 40; i++) {
    await sleep(200)
    await graphB.update()
    if (calls.some(c => c.includes(post.id))) { sawIt = true; break }
  }
  t.ok(sawIt, 'B\'s live query re-fired with the post that arrived purely via replication, with no local write on B at all')
  console.log('TEST: live cross-peer replication - passed')
})

