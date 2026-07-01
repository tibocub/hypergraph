const { pumpUntil, snapshotCanonical, assertConverged } = require('../harness')

module.exports = async function partialReplication (t, h) {
  const owner = await h.createPeer('pr-owner')

  const commentsKey = await owner.graph.createContext()
  const moderationKey = await owner.graph.createContext()

  owner.storage.commentsContext = commentsKey
  owner.storage.moderationContext = moderationKey

  const post = await owner.storage.createPost('seed')

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

  // A peer that only opens contexts initially.
  const peer = await h.createPeer('pr-peer')
  await peer.graph.openRoleBase(roleKeyHex)
  await peer.graph.openContext(commentsKey)
  const peerModeration = await peer.graph.openContext(moderationKey)
  peer.storage.commentsContext = commentsKey
  peer.storage.moderationContext = moderationKey

  const ownerModeration = await owner.graph.openContext(moderationKey)

  const repl = h.replicatePair(owner, peer)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(owner)
    await h.cleanupPeer(peer)
  })

  // Peer can write and/or receive context events even without the entity.
  await ownerModeration.addWriter(peerModeration.localKey)
  await pumpUntil(async () => {
    await peer.graph.update()
    if (!peerModeration.writable) throw new Error('peer moderation context not writable yet')
  }, 30000)

  await peer.storage.moderate(post.id, 'content.flag', 'x')

  await pumpUntil(async () => {
    const snap = await snapshotCanonical(peer, { postIds: [], targetIds: [post.id] })
    t.ok((snap.moderation[post.id] || []).length > 0)
    t.is(Boolean(snap.entities[post.id]), false)
  }, 30000)

  // Later, open the owner user core and converge.
  await peer.graph.openUserCore(owner.graph.key)

  await assertConverged(t, [owner, peer], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] }, minDurationMs: 100 })
}
