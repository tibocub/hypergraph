const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')

module.exports = async function crossContextIntegrity (t, h) {
  const p1 = await h.createPeer('cci-p1')
  const p2 = await h.createPeer('cci-p2')

  await p2.graph.openUserCore(p1.graph.key)
  await p1.graph.openUserCore(p2.graph.key)

  const commentsKey = await p1.graph.createContext()
  const moderationKey = await p1.graph.createContext()

  const p1Comments = await p1.graph.openContext(commentsKey)
  const p1Moderation = await p1.graph.openContext(moderationKey)
  const p2Comments = await p2.graph.openContext(commentsKey)
  const p2Moderation = await p2.graph.openContext(moderationKey)

  p1.storage.commentsContext = commentsKey
  p2.storage.commentsContext = commentsKey
  p1.storage.moderationContext = moderationKey
  p2.storage.moderationContext = moderationKey

  const repl = h.replicatePair(p1, p2)

  const roleKeyHex = await p1.graph.createRoleBase()
  await p1.graph.openRoleBase(roleKeyHex)
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

  await p1Comments.addWriter(p2Comments.localKey)
  await p1Moderation.addWriter(p2Moderation.localKey)

  await pumpUntil(async () => {
    await p2.graph.update()
    if (!p2Comments.writable) throw new Error('p2 comments context not writable yet')
    if (!p2Moderation.writable) throw new Error('p2 moderation context not writable yet')
  }, 30000)

  await p2.storage.reply(post.id, 'r')
  await p2.storage.moderate(post.id, 'content.hide', 'x')

  await assertConverged(t, [p1, p2], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] } })

  const snap = await snapshotCanonical(p1, { postIds: [post.id], targetIds: [post.id] })
  t.ok((snap.replies[post.id] || []).length >= 1)
  t.ok((snap.moderation[post.id] || []).length >= 1)
}
