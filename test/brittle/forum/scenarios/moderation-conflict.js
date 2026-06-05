const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')

module.exports = async function moderationConflict (t, h) {
  const p1 = await h.createPeer('mc-p1')
  const p2 = await h.createPeer('mc-p2')

  await p2.graph.openUserCore(p1.graph.key)
  await p1.graph.openUserCore(p2.graph.key)

  const commentsKey = await p1.graph.createContext()
  const moderationKey = await p1.graph.createContext()

  await p1.graph.openContext(commentsKey)
  const p1Moderation = await p1.graph.openContext(moderationKey)
  await p2.graph.openContext(commentsKey)
  const p2Moderation = await p2.graph.openContext(moderationKey)

  p1.storage.commentsContext = commentsKey
  p1.storage.moderationContext = moderationKey
  p2.storage.commentsContext = commentsKey
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

  await p1Moderation.addWriter(p2Moderation.localKey)
  await pumpUntil(async () => {
    await p2.graph.update()
    if (!p2Moderation.writable) throw new Error('p2 moderation context not writable yet')
  }, 30000)

  // Conflicting facts from different peers.
  await Promise.all([
    p1.storage.moderate(post.id, 'content.flag', 'f'),
    p2.storage.moderate(post.id, 'content.remove', 'r')
  ])

  await assertConverged(t, [p1, p2], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] } })

  const snap = await snapshotCanonical(p1, { postIds: [post.id], targetIds: [post.id] })
  const entries = snap.moderation[post.id] || []
  const flag = entries.find(e => e.action === 'content.flag')
  const remove = entries.find(e => e.action === 'content.remove')
  t.ok(flag)
  t.ok(remove)
  t.ok(flag.author && remove.author)
  t.is(flag.author === remove.author, false)
}
