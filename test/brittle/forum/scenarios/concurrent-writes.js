const { assertConverged, pumpUntil, snapshotCanonical } = require('../harness')

module.exports = async function concurrentWrites (t, h) {
  const p1 = await h.createPeer('cw-p1')
  const p2 = await h.createPeer('cw-p2')

  await p2.graph.openUserCore(p1.graph.key)
  await p1.graph.openUserCore(p2.graph.key)

  const commentsContextKey = await p1.graph.createContext()
  const moderationContextKey = await p1.graph.createContext()

  // Both peers must open the same contexts.
  const p1Comments = await p1.graph.openContext(commentsContextKey)
  const p1Moderation = await p1.graph.openContext(moderationContextKey)
  const p2Comments = await p2.graph.openContext(commentsContextKey)
  const p2Moderation = await p2.graph.openContext(moderationContextKey)

  p1.storage.commentsContext = commentsContextKey
  p2.storage.commentsContext = commentsContextKey
  p1.storage.moderationContext = moderationContextKey
  p2.storage.moderationContext = moderationContextKey

  const repl = h.replicatePair(p1, p2)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(p1)
    await h.cleanupPeer(p2)
  })

  const post = await p1.storage.createPost('seed')

  // Grant p2 write access to the shared comments context.
  await p1Comments.addWriter(p2Comments.localKey)

  await pumpUntil(async () => {
    await p2.graph.update()
    if (!p2Comments.writable) throw new Error('p2 comments context not writable yet')
  }, 30000)

  // Ensure p2 sees the post before replying.
  await pumpUntil(async () => {
    await p2.graph.update()
    const posts = await p2.storage.listPosts()
    if (posts.length !== 1) throw new Error('post not yet replicated')
    if (posts[0].id !== post.id) throw new Error('unexpected post id')
  }, 30000)

  // Concurrent-ish: fire without awaiting between them.
  await Promise.all([
    p1.storage.reply(post.id, 'p1'),
    p2.storage.reply(post.id, 'p2')
  ])

  await assertConverged(t, [p1, p2], { snapshotOpts: { postIds: [post.id] } })

  const snap = await snapshotCanonical(p1, { postIds: [post.id] })
  const replies = snap.replies[post.id] || []
  t.is(replies.length, 2)
}
