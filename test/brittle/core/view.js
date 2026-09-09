const test = require('brittle')
const { createGraph, sleep } = require('../helpers')

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

test('view: getContent() still returns the true latest version past 10 revisions — regression for a non-sortable index key', async (t) => {
  console.log('TEST: view getContent sort order - starting')
  // #applyContentAppend used to key content versions as `c:<entityId>:<seq>`
  // with a raw, unpadded seq. Hyperbee sorts keys as strings, so "c:id:9"
  // sorts AFTER "c:id:10" lexicographically — getContent()'s reverse-order,
  // limit:1 scan would silently return an old version once an entity had
  // been edited more than 10 times.
  const { graph } = await createGraph(t, 'view-get-content-sort-order')

  const post = await graph.put({ type: 'post' })
  for (let i = 0; i <= 10; i++) {
    await graph.putContent(post.id, `version ${i}`, 'text')
  }

  const latest = await graph.view.getContent(post.id)
  t.is(latest.body, 'version 10', 'getContent returns the true latest version (11th write), not a lexicographically-larger earlier one')
  console.log('TEST: view getContent sort order - passed')
})

test('view: getContent() rejects content forged by a peer who does not own the entity — regression for a missing apply-time ownership check', async (t) => {
  console.log('TEST: content forgery rejection - starting')
  // content/append previously had no ownership check at apply time (unlike
  // entity/create and entity/tombstone, both of which already required
  // event.author === coreKeyHex). Any peer whose UserCore is opened by the
  // victim (a normal, expected situation) could forge content for any
  // entityId once the victim's own view processed their UserCore.
  const victim = await createGraph(t, 'content-forgery-victim')
  const attacker = await createGraph(t, 'content-forgery-attacker')

  const victimPost = await victim.graph.put({ type: 'post' })
  await victim.graph.putContent(victimPost.id, 'legitimate content', 'text')

  const s1 = victim.store.replicate(true, { live: true })
  const s2 = attacker.store.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  t.teardown(async () => { try { s1.destroy() } catch {}; try { s2.destroy() } catch {} })

  // Victim opens the attacker's UserCore — a normal operation (e.g. the
  // attacker is a legitimate participant elsewhere) that is what makes the
  // attacker's events reach the victim's view at all.
  const attackerKeyHex = attacker.graph.key.toString('hex')
  await victim.graph.openUserCore(attackerKeyHex)

  // The attacker's own view must know about the victim's post before
  // putContent() will accept a call naming it (it requires the node to
  // already be visible locally) — the attacker opens the victim's UserCore
  // too, exactly as they'd need to in order to see/reply to it at all.
  const victimKeyHex = victim.graph.key.toString('hex')
  await attacker.graph.openUserCore(victimKeyHex)

  for (let i = 0; i < 20 && !(await attacker.graph.get(victimPost.id)); i++) {
    await sleep(200)
    await attacker.graph.update()
  }
  t.ok(await attacker.graph.get(victimPost.id), "attacker's view has replicated the victim's post")

  // Content versions are keyed `c:<entityId>:<seq>` with the WRITING core's
  // own seq — there's no per-core namespacing in that key. Padding the
  // attacker's own seq comfortably past the victim's (via unrelated writes)
  // means that, without the ownership check, the forged version's key would
  // win getContent()'s reverse-sorted scan on its own merits — this is what
  // makes the assertion below a genuine test of the ownership check itself,
  // not an accident of which peer happened to write at a lower seq.
  for (let i = 0; i < 5; i++) await attacker.graph.put({ type: 'filler' })

  // The forgery: attacker appends content/append to their OWN UserCore,
  // naming the victim's entityId.
  await attacker.graph.putContent(victimPost.id, 'forged content', 'text')

  for (let i = 0; i < 20; i++) {
    await sleep(200)
    await victim.graph.update()
    const current = await victim.graph.getContent(victimPost.id)
    if (current && current.body === 'forged content') break
  }

  const finalContent = await victim.graph.getContent(victimPost.id)
  t.is(finalContent.body, 'legitimate content', "the victim's own content is unaffected by the forgery, even though the forged event replicated")
  console.log('TEST: content forgery rejection - passed')
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
