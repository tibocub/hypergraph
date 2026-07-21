const test = require('brittle')
const { createGraph } = require('../helpers')

test('entities: put/get creates and retrieves a node', async (t) => {
  console.log('TEST: put/get - starting')
  const { graph } = await createGraph(t, 'entities-put-get')

  console.log('  Step 1: put a post entity')
  const post = await graph.put({ type: 'post' })
  t.ok(post.id, 'put returns an id')
  t.is(post.type, 'post', 'put echoes the type')

  console.log('  Step 2: get the entity back')
  const fetched = await graph.get(post.id)
  t.ok(fetched, 'get returns the node')
  t.is(fetched.id, post.id, 'fetched node has matching id')
  t.is(fetched.type, 'post', 'fetched node has matching type')
  console.log('TEST: put/get - passed')
})

test('entities: put author defaults to device identity', async (t) => {
  console.log('TEST: put author defaults - starting')
  const { graph } = await createGraph(t, 'entities-author')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const post = await graph.put({ type: 'post' })
  const fetched = await graph.get(post.id)

  t.is(fetched.author, author, 'entity author matches device identity')
  console.log('TEST: put author defaults - passed')
})

test('entities: get returns null for unknown id', async (t) => {
  console.log('TEST: get unknown id - starting')
  const { graph } = await createGraph(t, 'entities-get-unknown')

  const result = await graph.get('post/does-not-exist')
  t.is(result, null, 'get returns null for a missing entity')
  console.log('TEST: get unknown id - passed')
})

test('entities: del tombstones a node', async (t) => {
  console.log('TEST: del - starting')
  const { graph } = await createGraph(t, 'entities-del')

  console.log('  Step 1: create and confirm entity exists')
  const post = await graph.put({ type: 'post' })
  t.ok(await graph.get(post.id), 'entity exists before delete')

  console.log('  Step 2: delete entity')
  await graph.del(post.id)

  console.log('  Step 3: verify entity is gone')
  t.is(await graph.get(post.id), null, 'entity is null after delete')
  console.log('TEST: del - passed')
})

test('entities: del on an unknown id throws', async (t) => {
  console.log('TEST: del unknown id - starting')
  const { graph } = await createGraph(t, 'entities-del-unknown')

  await t.exception(graph.del('post/does-not-exist'), /Entity not found/, 'deleting an unknown id throws')
  console.log('TEST: del unknown id - passed')
})

test('entities: putContent/getContent stores and retrieves text content', async (t) => {
  console.log('TEST: putContent/getContent - starting')
  const { graph } = await createGraph(t, 'entities-content')

  console.log('  Step 1: create entity')
  const post = await graph.put({ type: 'post' })

  console.log('  Step 2: attach content')
  await graph.putContent(post.id, 'Hello, World!', 'text')

  console.log('  Step 3: read content back')
  const content = await graph.getContent(post.id)
  t.ok(content, 'content is returned')
  t.is(content.body, 'Hello, World!', 'content body matches what was written')
  console.log('TEST: putContent/getContent - passed')
})

test('entities: getContent on an entity with no content returns null', async (t) => {
  console.log('TEST: getContent empty - starting')
  const { graph } = await createGraph(t, 'entities-content-empty')

  const post = await graph.put({ type: 'post' })
  const content = await graph.getContent(post.id)
  t.is(content, null, 'no content has been written yet')
  console.log('TEST: getContent empty - passed')
})

test('entities: putContent errors on an unknown entity id', async (t) => {
  console.log('TEST: putContent unknown entity - starting')
  const { graph } = await createGraph(t, 'entities-content-unknown')

  await t.exception(
    graph.putContent('post/does-not-exist', 'orphan content', 'text'),
    'putContent rejects when the entity does not exist'
  )
  console.log('TEST: putContent unknown entity - passed')
})

test('entities: getByType returns entities of a given type in chronological order', async (t) => {
  console.log('TEST: getByType - starting')
  const { graph } = await createGraph(t, 'entities-getbytype')

  const post1 = await graph.put({ type: 'post' })
  await graph.put({ type: 'comment' })
  const post2 = await graph.put({ type: 'post' })

  const posts = []
  for await (const node of graph.getByType('post')) posts.push(node)
  t.is(posts.length, 2, 'only posts are returned, not comments')
  t.alike(posts.map(p => p.id), [post1.id, post2.id], 'posts come back in chronological order')
  console.log('TEST: getByType - passed')
})

test('entities: getByAuthor scans the author\'s own UserCore, returning nothing for an author whose core was never opened', async (t) => {
  console.log('TEST: getByAuthor own core - starting')
  const { graph } = await createGraph(t, 'entities-getbyauthor')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const post1 = await graph.put({ type: 'post' })
  const post2 = await graph.put({ type: 'comment' })

  const own = []
  for await (const node of graph.getByAuthor(author)) own.push(node)
  t.is(own.length, 2, 'both of this identity\'s own entities are returned, regardless of type')
  t.alike(own.map(n => n.id), [post1.id, post2.id], 'in the order they were created')

  console.log('  an author whose core was never opened/replicated yields nothing, not an error')
  const unknownAuthor = 'a'.repeat(64)
  const forUnknown = []
  for await (const node of graph.getByAuthor(unknownAuthor)) forUnknown.push(node)
  t.is(forUnknown.length, 0, 'no entities for an author whose core isn\'t locally available')
  console.log('TEST: getByAuthor own core - passed')
})

test('entities: getByAuthor correctly finds a REMOTE author\'s entities once their core is opened, and excludes everyone else\'s', async (t) => {
  console.log('TEST: getByAuthor cross-peer - starting')
  const Corestore = require('corestore')
  const path = require('path')
  const os = require('os')
  const { Hypergraph } = require('../../../index.js')

  // Two identities sharing one Corestore — no replication needed, since
  // both cores physically live in the same store (same pattern used
  // elsewhere in this suite for multi-author scenarios).
  const dir = path.join(os.tmpdir(), `hypergraph-getbyauthor-${process.pid}-${Date.now()}`)
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

  const postA = await graphA.put({ type: 'post' })
  const postB = await graphB.put({ type: 'post' })

  await graphA.openUserCore(graphB.key)

  const seenByA = []
  for await (const node of graphA.getByAuthor(graphB.key.toString('hex'))) seenByA.push(node)
  t.is(seenByA.length, 1, 'A sees exactly B\'s one entity once B\'s core is opened')
  t.is(seenByA[0].id, postB.id, 'and it\'s the correct one')

  const seenByAForOwnAuthor = []
  for await (const node of graphA.getByAuthor(graphA.key.toString('hex'))) seenByAForOwnAuthor.push(node)
  t.is(seenByAForOwnAuthor.length, 1, 'A\'s own entities are separate from B\'s — not mixed together')
  t.is(seenByAForOwnAuthor[0].id, postA.id, 'and it\'s A\'s own post, not B\'s')
  console.log('TEST: getByAuthor cross-peer - passed')
})
