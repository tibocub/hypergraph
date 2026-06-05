const { assertConverged } = require('../harness')

module.exports = async function lateJoiner (t, h) {
  const p1 = await h.createPeer('late-p1')

  // Create contexts on p1 and rebind storage to them.
  const commentsContext = await p1.graph.createContext()
  const moderationContext = await p1.graph.createContext()
  p1.storage.commentsContext = commentsContext
  p1.storage.moderationContext = moderationContext

  const post = await p1.storage.createPost('seed')
  await p1.storage.reply(post.id, 'r1')

  // Late joiner opens from scratch and must converge.
  const p2 = await h.createPeer('late-p2')
  await p2.graph.openUserCore(p1.graph.key)
  await p2.graph.openContext(commentsContext)
  await p2.graph.openContext(moderationContext)
  p2.storage.commentsContext = commentsContext
  p2.storage.moderationContext = moderationContext

  const repl = h.replicatePair(p1, p2)

  t.teardown(async () => {
    await repl.close()
    await h.cleanupPeer(p1)
    await h.cleanupPeer(p2)
  })

  await assertConverged(t, [p1, p2])
}
