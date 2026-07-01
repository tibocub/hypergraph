const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')
const ForumPolicy = require('../../../../examples/forum/policy')

function assertModerationEvent (t, evt) {
  t.ok(evt, 'event exists')
  t.ok(evt.author, 'has author')
  t.ok(evt.action, 'has action')
  t.ok(evt.target, 'has target')
  t.ok(typeof evt.timestamp === 'number', 'has timestamp')
  t.ok(evt.signature, 'has signature')
}

module.exports = async function moderationPropagation (t, h) {
  const p1 = await h.createPeer('mod-p1')
  const p2 = await h.createPeer('mod-p2')

  await p2.graph.openUserCore(p1.graph.key)
  await p1.graph.openUserCore(p2.graph.key)

  const commentsContextKey = await p1.graph.createContext()
  const moderationContextKey = await p1.graph.createContext()

  await p1.graph.openContext(commentsContextKey)
  const p1Moderation = await p1.graph.openContext(moderationContextKey)
  await p2.graph.openContext(commentsContextKey)
  const p2Moderation = await p2.graph.openContext(moderationContextKey)

  p1.storage.commentsContext = commentsContextKey
  p2.storage.commentsContext = commentsContextKey
  p1.storage.moderationContext = moderationContextKey
  p2.storage.moderationContext = moderationContextKey

  const repl = h.replicatePair(p1, p2)

  const roleKeyHex = await p1.graph.createRoleBase()
  const owner = p1.graph.key.toString('hex')
  await p1.graph.roleBase.init(owner)
  await p1.graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove', 'content.reveal'],
    author: owner,
    timestamp: Date.now()
  })
  await p2.graph.openRoleBase(roleKeyHex)
  await p1.graph.update()
  await p2.graph.update()

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(p1)
    await h.cleanupPeer(p2)
  })

  const post = await p1.storage.createPost('seed')

  await pumpUntil(async () => {
    await p2.graph.update()
    const posts = await p2.storage.listPosts()
    if (posts.length !== 1) throw new Error('post not yet replicated')
  }, 30000)

  // Grant p2 write access to moderation context.
  await p1Moderation.addWriter(p2Moderation.localKey)
  await pumpUntil(async () => {
    await p2.graph.update()
    if (!p2Moderation.writable) throw new Error('p2 moderation context not writable yet')
  }, 30000)

  const ev = await p2.storage.moderate(post.id, 'content.hide', 'test')

  assertModerationEvent(t, ev)

  await assertConverged(t, [p1, p2], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] } })

  const snap = await snapshotCanonical(p1, { postIds: [post.id], targetIds: [post.id] })
  const entries = snap.moderation[post.id] || []
  t.ok(entries.length >= 1)

  const events1 = await p1.storage.getModeration(post.id)
  const events2 = await p2.storage.getModeration(post.id)
  t.alike(events2, events1)

  const trusted = entries[0].author
  const policy = new ForumPolicy({ trustedModeratorKeys: [trusted] })
  t.is(policy.shouldShow(events1), false)
}
