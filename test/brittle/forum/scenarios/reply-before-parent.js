const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')
const crypto = require('hypercore-crypto')

module.exports = async function replyBeforeParent (t, h) {
  const owner = await h.createPeer('rbp-owner')
  const peer = await h.createPeer('rbp-peer')

  const commentsKey = await owner.graph.createContext()
  const moderationKey = await owner.graph.createContext()

  const ownerComments = await owner.graph.openContext(commentsKey)
  await owner.graph.openContext(moderationKey)
  const peerComments = await peer.graph.openContext(commentsKey)
  await peer.graph.openContext(moderationKey)

  owner.storage.commentsContext = commentsKey
  owner.storage.moderationContext = moderationKey
  peer.storage.commentsContext = commentsKey
  peer.storage.moderationContext = moderationKey

  const repl = h.replicatePair(owner, peer)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(owner)
    await h.cleanupPeer(peer)
  })

  // Owner creates the post ID, but peer will not open the owner user core yet.
  const post = await owner.storage.createPost('seed')

  // Grant peer write access to the shared comments context.
  await ownerComments.addWriter(peerComments.localKey)
  await pumpUntil(async () => {
    await peer.graph.update()
    if (!peerComments.writable) throw new Error('peer comments context not writable yet')
  }, 30000)

  // Peer writes a reply edge to a postId it doesn't yet have locally.
  // This should not crash and should replicate.
  const comment = await peer.graph.put({ type: 'comment' })
  await peer.graph.putContent(comment.id, 'orphan', 'text')
  const peerKeyPair = crypto.keyPair()
  await peer.graph.relate({
    from: comment.id,
    to: post.id,
    type: 'reply',
    keyPair: peerKeyPair,
    context: commentsKey
  })

  // Wait until the relation is visible on the peer without requiring the post entity.
  await pumpUntil(async () => {
    const snapPeer = await snapshotCanonical(peer, { postIds: [post.id], targetIds: [] })
    t.ok((snapPeer.replies[post.id] || []).includes(comment.id))
    t.is(Boolean(snapPeer.entities[post.id]), false)
  }, 30000)

  // Now open the owner user core and converge fully.
  await peer.graph.openUserCore(owner.graph.key)
  await owner.graph.openUserCore(peer.graph.key)
  await assertConverged(t, [owner, peer], { snapshotOpts: { postIds: [post.id], targetIds: [post.id] }, minDurationMs: 100 })
}
