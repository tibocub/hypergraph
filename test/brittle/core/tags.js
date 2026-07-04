const test = require('brittle')
const { createGraph } = require('../helpers')

test('tags: tag makes an entity discoverable by getByTag', async (t) => {
  console.log('TEST: tag basic - starting')
  const { graph } = await createGraph(t, 'tags-basic')

  console.log('  Step 1: create entity and context')
  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext()

  console.log('  Step 2: tag the entity')
  await graph.tag(post.id, 'important', { context })

  console.log('  Step 3: verify it shows up under the tag')
  const tagged = []
  for await (const n of graph.getByTag('important')) tagged.push(n)
  t.is(tagged.length, 1, 'exactly one entity has the tag')
  t.is(tagged[0].id, post.id, 'tagged entity matches the post')
  console.log('TEST: tag basic - passed')
})

test('tags: getByTag filters by single author', async (t) => {
  console.log('TEST: getByTag author filter - starting')
  const { graph } = await createGraph(t, 'tags-author')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext()
  await graph.tag(post.id, 'important', { context })

  const taggedByAuthor = []
  for await (const n of graph.getByTag('important', { author })) taggedByAuthor.push(n)
  t.is(taggedByAuthor.length, 1, 'author filter matches the device identity')
  t.ok(taggedByAuthor[0].id.startsWith('post/'), 'result is the post entity')
  t.is(taggedByAuthor[0].author, author, 'result author matches filter')
  console.log('TEST: getByTag author filter - passed')
})

test('tags: getByTag filters by an authors allow-list', async (t) => {
  console.log('TEST: getByTag authors filter - starting')
  const { graph } = await createGraph(t, 'tags-authors-list')

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext()
  await graph.tag(post.id, 'important', { context })

  const taggedTrusted = []
  for await (const n of graph.getByTag('important', { authors: [author] })) taggedTrusted.push(n)
  t.is(taggedTrusted.length, 1, 'entity matches when author is in the allow-list')

  const taggedUntrusted = []
  for await (const n of graph.getByTag('important', { authors: ['0'.repeat(64)] })) taggedUntrusted.push(n)
  t.is(taggedUntrusted.length, 0, 'entity is excluded when author is not in the allow-list')
  console.log('TEST: getByTag authors filter - passed')
})

test('tags: untag removes the entity from tag results', async (t) => {
  console.log('TEST: untag - starting')
  const { graph } = await createGraph(t, 'tags-untag')

  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext()

  console.log('  Step 1: tag and confirm visible')
  await graph.tag(post.id, 'important', { context })
  let tagged = []
  for await (const n of graph.getByTag('important')) tagged.push(n)
  t.is(tagged.length, 1, 'entity is tagged')

  console.log('  Step 2: untag and confirm no longer visible')
  await graph.untag(post.id, 'important', { context })
  tagged = []
  for await (const n of graph.getByTag('important')) tagged.push(n)
  t.is(tagged.length, 0, 'entity is no longer tagged')
  console.log('TEST: untag - passed')
})

test('tags: getByTag on a tag nobody used returns nothing', async (t) => {
  console.log('TEST: getByTag empty - starting')
  const { graph } = await createGraph(t, 'tags-empty')

  const results = []
  for await (const n of graph.getByTag('nonexistent-tag')) results.push(n)
  t.is(results.length, 0, 'unused tag yields an empty result set')
  console.log('TEST: getByTag empty - passed')
})
