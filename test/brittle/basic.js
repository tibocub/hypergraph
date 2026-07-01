const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const os = require('os')
const path = require('path')
const fs = require('fs')
const crypto = require('hypercore-crypto')

test('hypergraph: basic operations', async (t) => {
  const tmpDir = path.join(os.tmpdir(), `hypergraph-test-basic-${process.pid}-${Date.now()}-${Math.random()}`)
  fs.mkdirSync(tmpDir, { recursive: true })

  const store = new Corestore(tmpDir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const contextKey = await graph.createContext()

  const post1 = await graph.put({ type: 'post' })
  const post2 = await graph.put({ type: 'post' })
  const user1 = await graph.put({ type: 'user' })

  t.ok(await graph.get(post1.id))
  t.ok(await graph.get(user1.id))

  await graph.putContent(post1.id, 'Hello, World!', 'text')
  const content = await graph.getContent(post1.id)
  t.is(content.body, 'Hello, World!')

  await graph.relate({
    from: post2.id,
    to: post1.id,
    type: 'reply',
    context: contextKey
  })

  // Relating the same triple twice should not create duplicate live edges
  await graph.relate({
    from: post2.id,
    to: post1.id,
    type: 'reply',
    context: contextKey
  })

  const outEdges = []
  for await (const e of graph.edges(post2.id, { direction: 'out' })) outEdges.push(e)
  t.alike(outEdges.map(e => e.type), ['reply'])

  const inEdges = []
  for await (const e of graph.edges(post1.id, { direction: 'in', type: 'reply' })) inEdges.push(e)
  t.is(inEdges.length, 1)

  t.is(await graph.countEdgesIn(post1.id, 'reply'), 1)
  t.is(await graph.countEdgesOut(post2.id, 'reply'), 1)

  await graph.unrelate({
    from: post2.id,
    to: post1.id,
    type: 'reply',
    context: contextKey
  })

  t.is(await graph.countEdgesIn(post1.id, 'reply'), 0)
  t.is(await graph.countEdgesOut(post2.id, 'reply'), 0)

  await graph.tag(post1.id, 'important', { context: contextKey })
  // TODO: Re-enable this test once author check is re-enabled in tag()
  // const keyPairBob = crypto.keyPair()
  // await t.exception(graph.tag(post1.id, 'important', { keyPair: keyPairBob, context: contextKey }), /Only the entity author can tag it/)
  const tagged = []
  for await (const n of graph.getByTag('important')) tagged.push(n)
  t.is(tagged.length, 1)

  const taggedAlice = []
  for await (const n of graph.getByTag('important', { author })) taggedAlice.push(n)
  t.is(taggedAlice.length, 1)
  t.ok(taggedAlice[0].id.startsWith('post/'))
  t.is(taggedAlice[0].author, author)

  const taggedTrusted = []
  for await (const n of graph.getByTag('important', { authors: [author] })) taggedTrusted.push(n)
  t.is(taggedTrusted.length, 1)

  await graph.del(post2.id)
  t.is(await graph.get(post2.id), null)
})
