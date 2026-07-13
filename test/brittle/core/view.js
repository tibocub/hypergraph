const test = require('brittle')
const { createGraph } = require('../helpers')

test('view: update() processes new events and materializes them into the view', async (t) => {
  console.log('TEST: view update - starting')
  const { graph } = await createGraph(t, 'view-update')

  console.log('  Step 1: put an entity, then confirm it is visible via the view directly')
  const post = await graph.put({ type: 'post' })

  console.log('  Step 2: an explicit graph.update() should be a safe no-op here since put() already applies its own event')
  await graph.update()
  const node = await graph.view.getNode(post.id)
  t.ok(node, 'entity is visible via graph.view.getNode() after update()')
  t.is(node.id, post.id, 'node id matches')
  console.log('TEST: view update - passed')
})

test('view: getNode() returns the materialized entity or null', async (t) => {
  console.log('TEST: view getNode - starting')
  const { graph } = await createGraph(t, 'view-get-node')

  const missing = await graph.view.getNode('post/does-not-exist')
  t.is(missing, null, 'getNode returns null for an unknown id')

  const post = await graph.put({ type: 'post' })
  const found = await graph.view.getNode(post.id)
  t.ok(found, 'getNode returns the entity once it exists')
  t.is(found.type, 'post', 'returned entity has the expected type')
  console.log('TEST: view getNode - passed')
})

test('view: getNode() returns null for a deleted (tombstoned) entity', async (t) => {
  console.log('TEST: view getNode tombstone - starting')
  const { graph } = await createGraph(t, 'view-get-node-tombstone')

  const post = await graph.put({ type: 'post' })
  t.ok(await graph.view.getNode(post.id), 'entity exists before delete')

  await graph.del(post.id)
  t.is(await graph.view.getNode(post.id), null, 'getNode returns null after the entity is tombstoned')
  console.log('TEST: view getNode tombstone - passed')
})

test('view: getContent() returns the latest content or null', async (t) => {
  console.log('TEST: view getContent - starting')
  const { graph } = await createGraph(t, 'view-get-content')

  const post = await graph.put({ type: 'post' })
  t.is(await graph.view.getContent(post.id), null, 'no content yet')

  await graph.putContent(post.id, 'first version', 'text')
  const first = await graph.view.getContent(post.id)
  t.is(first.body, 'first version', 'getContent returns the content that was written')

  console.log('  Step: overwrite with a second version and confirm getContent tracks the latest one')
  await graph.putContent(post.id, 'second version', 'text')
  const second = await graph.view.getContent(post.id)
  t.is(second.body, 'second version', 'getContent returns the most recently written content')
  console.log('TEST: view getContent - passed')
})

test('view: getEdges() supports direction and type filters directly on the view', async (t) => {
  console.log('TEST: view getEdges - starting')
  const { graph } = await createGraph(t, 'view-edges')

  const post = await graph.put({ type: 'post' })
  const comment = await graph.put({ type: 'comment' })
  const context = await graph.createContext()
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })

  const out = []
  for await (const e of graph.view.getEdges(comment.id, { direction: 'out' })) out.push(e)
  t.is(out.length, 1, 'view.getEdges() returns the outgoing edge directly')

  const inFiltered = []
  for await (const e of graph.view.getEdges(post.id, { direction: 'in', type: 'reply' })) inFiltered.push(e)
  t.is(inFiltered.length, 1, 'view.getEdges() applies the type filter directly')

  const inWrongType = []
  for await (const e of graph.view.getEdges(post.id, { direction: 'in', type: 'like' })) inWrongType.push(e)
  t.is(inWrongType.length, 0, 'view.getEdges() returns nothing for a type that was never used')
  console.log('TEST: view getEdges - passed')
})

test('view: getByTag() and hasTag() agree on tag membership across contexts', async (t) => {
  console.log('TEST: view getByTag/hasTag - starting')
  const { graph } = await createGraph(t, 'view-get-by-tag')

  const post = await graph.put({ type: 'post' })
  const context = await graph.createContext()

  t.absent(await graph.view.hasTag(post.id, 'featured'), 'hasTag is false before tagging')

  await graph.tag(post.id, 'featured', { context })
  t.ok(await graph.view.hasTag(post.id, 'featured'), 'hasTag is true after tagging')

  const tagged = []
  for await (const n of graph.view.getByTag('featured')) tagged.push(n)
  t.is(tagged.length, 1, 'getByTag() returns the tagged entity directly on the view')
  t.is(tagged[0].id, post.id, 'returned entity matches')

  await graph.untag(post.id, 'featured', { context })
  t.absent(await graph.view.hasTag(post.id, 'featured'), 'hasTag is false again after untagging')
  console.log('TEST: view getByTag/hasTag - passed')
})

test('view: registerDeviceIdentity()/getIdentityForDevice() round-trip a mapping', async (t) => {
  console.log('TEST: view device-identity mapping - starting')
  const { graph } = await createGraph(t, 'view-device-identity')

  const deviceKey = 'a'.repeat(64)
  const identityKey = 'b'.repeat(64)

  t.is(await graph.view.getIdentityForDevice(deviceKey), null, 'no mapping registered yet')

  await graph.view.registerDeviceIdentity(deviceKey, identityKey)
  t.is(await graph.view.getIdentityForDevice(deviceKey), identityKey, 'mapping is retrievable after registering')
  console.log('TEST: view device-identity mapping - passed')
})

test('view: getIdentity() returns a profile by public key, or null', async (t) => {
  console.log('TEST: view getIdentity - starting')
  const { graph } = await createGraph(t, 'view-get-identity')

  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  t.is(await graph.view.getIdentity(devicePublicKeyHex), null, 'no identity profile set yet')

  await graph.setIdentity({ username: 'alice', bio: 'test' })
  const identity = await graph.view.getIdentity(devicePublicKeyHex)
  t.ok(identity, 'identity profile is retrievable directly from the view')
  t.is(identity.username, 'alice', 'username matches')
  console.log('TEST: view getIdentity - passed')
})
