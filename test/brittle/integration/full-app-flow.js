// This test exercises a realistic app flow end-to-end in a single process:
// identity -> entities -> content -> relations -> tags -> roles ->
// moderation -> query -> export/join. It does not require real network
// access (no Hyperswarm/DHT); cross-peer replication over the DHT is
// covered separately in test/brittle/replication/*.js.

const test = require('brittle')
const crypto = require('hypercore-crypto')
const { Hypergraph } = require('../../../index.js')
const { createGraph } = require('../helpers')

test('full-app-flow: a small forum-like flow works end-to-end on a single graph', async (t) => {
  console.log('TEST: full app flow - starting')
  const { graph } = await createGraph(t, 'full-app-flow')

  console.log('  Step 1: set up identity profile')
  await graph.setIdentity({ username: 'alice', bio: 'building hypergraph' })
  const author = graph.identity.deviceKeyPair.publicKey.toString('hex')

  console.log('  Step 2: set up a role base with the author as owner')
  await graph.createRoleBase()
  await graph.roleBase.init(author)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide'],
    author,
    timestamp: Date.now()
  })
  await graph.update()
  t.is(await graph.getRole(author), 'owner', 'author is the owner')

  console.log('  Step 3: create a post with content, tag it, and comment on it')
  const context = await graph.createContext()
  const post = await graph.put({ type: 'post' })
  await graph.putContent(post.id, 'Hello, Hypergraph!', 'text')
  await graph.tag(post.id, 'announcement', { context })

  const comment = await graph.put({ type: 'comment' })
  await graph.putContent(comment.id, 'Nice post!', 'text')
  await graph.relate({ from: comment.id, to: post.id, type: 'reply', context })

  console.log('  Step 4: verify the post is queryable by type, tag, and traversal')
  const posts = await graph.query().type('post').toArray()
  t.is(posts.length, 1, 'exactly one post exists')

  const announcements = await graph.query().type('post').tag('announcement').toArray()
  t.is(announcements.length, 1, 'post is discoverable by tag')

  const replies = await graph.query().type('post').in('reply').toArray()
  t.is(replies.length, 1, 'post has one reply via traversal')
  t.is(replies[0].id, comment.id, 'traversal returns the comment')

  console.log('  Step 5: a member flags the comment, and it is queryable as a moderation fact')
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')
  await graph.setRole(memberPubkey, 'member', { keyPair: graph.identity.deviceKeyPair })
  await graph.update()
  t.is(await graph.getRole(memberPubkey), 'member', 'member role was granted')

  await graph.moderateAction({
    context,
    action: 'content.flag',
    target: comment.id,
    reason: 'spam',
    keyPair: memberKeyPair
  })
  await graph.update()

  const flags = []
  for await (const e of graph.queryContext({ type: 'moderation', context, target: comment.id, authors: [memberPubkey] })) flags.push(e)
  t.is(flags.length, 1, 'moderation fact is queryable once the author is trusted')
  t.is(flags[0].action, 'content.flag', 'flag action recorded correctly')

  console.log('  Step 6: export the graph and join it from a fresh store')
  const bootstrap = await graph.export()

  const Corestore = require('corestore')
  const os = require('os')
  const path = require('path')
  const fs = require('fs')
  const dir = path.join(os.tmpdir(), `hypergraph-full-app-flow-joined-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  fs.mkdirSync(dir, { recursive: true })
  const store = new Corestore(dir)
  const joined = await Hypergraph.join(store, bootstrap)
  t.teardown(async () => {
    await joined.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const joinedContext = await joined.openContext(bootstrap.contexts[0].key)
  t.ok(joinedContext, 'joined graph can open the exported context')
  console.log('TEST: full app flow - passed')
})
