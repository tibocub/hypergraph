const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')

module.exports = async function outOfOrderReplication (t, h) {
  const owner = await h.createPeer('ooo-owner')
  const peer = await h.createPeer('ooo-peer')

  const commentsContextKey = await owner.graph.createContext({ roles: 'rolebase' })
  const moderationContextKey = await owner.graph.createContext({ roles: 'rolebase' })

  await owner.graph.openContext(commentsContextKey)
  await owner.graph.openContext(moderationContextKey)

  await peer.graph.openUserCore(owner.graph.key)
  await peer.graph.openContext(commentsContextKey)
  await peer.graph.openContext(moderationContextKey)

  owner.storage.commentsContext = commentsContextKey
  owner.storage.moderationContext = moderationContextKey
  peer.storage.commentsContext = commentsContextKey
  peer.storage.moderationContext = moderationContextKey

  const repl = h.replicatePair(owner, peer)

  const roleKeyHex = await owner.graph.createRoleBase()
  const siteOwner = owner.graph.key.toString('hex')
  await owner.graph.roleBase.init(siteOwner)
  await owner.graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag', 'content.hide', 'content.remove', 'content.reveal'],
    author: siteOwner,
    timestamp: Date.now()
  })
  await peer.graph.openRoleBase(roleKeyHex)
  await owner.graph.update()
  await peer.graph.update()

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(owner)
    await h.cleanupPeer(peer)
  })

  const post = await owner.storage.createPost('seed')

  await pumpUntil(async () => {
    await peer.graph.update()
    const posts = await peer.storage.listPosts()
    if (posts.length !== 1) throw new Error('post not yet replicated')
  }, 30000)

  const peer2 = await h.createPeer('ooo-peer2')
  await peer2.graph.openRoleBase(roleKeyHex)
  const ownerModeration = await owner.graph.openContext(moderationContextKey)
  const peer2Moderation = await peer2.graph.openContext(moderationContextKey)
  peer2.storage.moderationContext = moderationContextKey

  const repl2 = h.replicatePair(owner, peer2)
  t.teardown(async () => {
    await repl2.close()
    await h.cleanupPeer(peer2)
  })

  await ownerModeration.addWriter(peer2Moderation.localKey)

  await pumpUntil(async () => {
    await peer2.graph.update()
    if (!peer2Moderation.writable) throw new Error('peer2 moderation context not writable yet')
  }, 30000)

  const ev = await peer2.storage.moderate(post.id, 'content.flag', 'ooo')
  t.ok(ev && typeof ev.timestamp === 'number')
  t.ok(ev && ev.signature)

  await pumpUntil(async () => {
    const snap = await snapshotCanonical(peer2, { postIds: [], targetIds: [post.id] })
    const events = snap.moderation[post.id] || []
    t.ok(events.length >= 1)
  }, 30000)

  await peer2.graph.openUserCore(owner.graph.key)

  await assertConverged(t, [owner, peer2], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] } })
}
