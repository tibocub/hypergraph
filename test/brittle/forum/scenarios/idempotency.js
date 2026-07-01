const { assertConverged, snapshotCanonical } = require('../harness')

module.exports = async function idempotency (t, h) {
  const p1 = await h.createPeer('idem-p1')
  const p2 = await h.createPeer('idem-p2')

  await p2.graph.openUserCore(p1.graph.key)

  const commentsKey = await p1.graph.createContext()
  const moderationKey = await p1.graph.createContext()

  await p1.graph.openContext(commentsKey)
  await p1.graph.openContext(moderationKey)
  await p2.graph.openContext(commentsKey)
  await p2.graph.openContext(moderationKey)

  p1.storage.commentsContext = commentsKey
  p1.storage.moderationContext = moderationKey
  p2.storage.commentsContext = commentsKey
  p2.storage.moderationContext = moderationKey

  const repl = h.replicatePair(p1, p2)

  const roleKeyHex = await p1.graph.createRoleBase()
  const siteOwner = p1.graph.key.toString('hex')
  await p1.graph.roleBase.init(siteOwner)
  await p1.graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove', 'content.reveal'],
    author: siteOwner,
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

  // Same logical vote multiple times.
  await p1.storage.moderate(post.id, 'content.flag', '1')
  await p1.storage.moderate(post.id, 'content.flag', '2')
  await p1.storage.moderate(post.id, 'content.flag', '3')

  await assertConverged(t, [p1, p2], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] } })

  const snap = await snapshotCanonical(p1, { postIds: [post.id], targetIds: [post.id] })
  const entries = snap.moderation[post.id] || []
  t.is(entries.length, 1)
}
