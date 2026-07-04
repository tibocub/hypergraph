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
