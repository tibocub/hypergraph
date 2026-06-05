const ForumPolicy = require('../forum/policy')

function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

async function projectPost (storage, policy, post) {
  const content = await storage.graph.getContent(post.id)
  const ident = await storage.getIdentity(post.author)
  const username = ident && ident.username ? ident.username : shortKey(post.author)

  let replyCount = 0
  for await (const _e of storage.graph.edges(post.id, { direction: 'in', type: 'reply' })) replyCount++

  const moderation = await storage.getModeration(post.id)

  const evald = policy.evaluate(moderation)

  return {
    id: post.id,
    author: post.author,
    username,
    createdAt: post.createdAt || null,
    body: content ? content.body : '',
    replyCount,
    visible: evald.visible,
    moderation: {
      action: evald.action,
      flags: evald.flags,
      maxFlags: policy.maxFlags
    }
  }
}

async function projectThread (storage, policy, postId) {
  const post = await storage.graph.get(postId)
  if (!post) return null

  const postContent = await storage.graph.getContent(postId)
  const postIdent = await storage.getIdentity(post.author)
  const postUsername = postIdent && postIdent.username ? postIdent.username : shortKey(post.author)

  const moderation = await storage.getModeration(postId)
  const evald = policy.evaluate(moderation)

  const replies = await storage.getReplies(postId)
  const projectedReplies = []
  for (const r of replies) {
    const ident = await storage.getIdentity(r.node.author)
    const username = ident && ident.username ? ident.username : shortKey(r.node.author)

    const moderation = await storage.getModeration(r.node.id)
    const evaldReply = policy.evaluate(moderation)
    projectedReplies.push({
      id: r.node.id,
      author: r.node.author,
      username,
      createdAt: r.node.createdAt || null,
      body: r.content ? r.content.body : '',
      visible: evaldReply.visible,
      moderation: {
        action: evaldReply.action,
        flags: evaldReply.flags,
        maxFlags: policy.maxFlags
      }
    })
  }

  projectedReplies.sort((a, b) => {
    const ta = a.createdAt || 0
    const tb = b.createdAt || 0
    return ta - tb
  })

  return {
    id: postId,
    author: post.author,
    username: postUsername,
    createdAt: post.createdAt || null,
    body: postContent ? postContent.body : '',
    visible: evald.visible,
    moderation: {
      action: evald.action,
      flags: evald.flags,
      maxFlags: policy.maxFlags
    },
    replies: projectedReplies
  }
}

async function buildForumState (storage, contexts, policy, opts = {}) {
  await storage.graph.update()

  const threadId = opts.thread || null

  const posts = await storage.listPosts()
  const projectedPosts = []
  for (const p of posts) projectedPosts.push(await projectPost(storage, policy, p))

  projectedPosts.sort((a, b) => {
    const ta = a.createdAt || 0
    const tb = b.createdAt || 0
    return tb - ta
  })

  const mePubkey = storage.graph.key ? storage.graph.key.toString('hex') : null
  const meIdent = mePubkey ? await storage.getIdentity(mePubkey) : null
  const meModPubkey = (storage.moderationKeyPair && storage.moderationKeyPair.publicKey)
    ? storage.moderationKeyPair.publicKey.toString('hex')
    : null
  const isModerator = meModPubkey ? policy.trustedModeratorKeys.has(meModPubkey) : false

  const thread = threadId ? await projectThread(storage, policy, threadId) : null

  return {
    me: {
      pubkey: mePubkey,
      username: meIdent && meIdent.username ? meIdent.username : null,
      isModerator,
      moderationPubkey: meModPubkey
    },
    forum: {
      contexts: {
        comments: contexts.comments,
        moderation: contexts.moderation
      },
      moderation: {
        maxFlags: policy.maxFlags
      }
    },
    posts: projectedPosts,
    thread
  }
}

module.exports = {
  buildForumState,
  ForumPolicy
}
