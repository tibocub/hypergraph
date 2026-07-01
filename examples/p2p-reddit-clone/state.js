const RedditPolicy = require('../forum/policy')

function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

async function projectPost (storage, policy, post) {
  const content = await storage.graph.getContent(post.id)
  const ident = await storage.getIdentity(post.author)
  const username = ident && ident.username ? ident.username : shortKey(post.author)

  let commentCount = 0
  for await (const _e of storage.graph.edges(post.id, { direction: 'in', type: 'reply' })) commentCount++

  const voteCount = await storage.getVoteCount(post.id)
  const userVote = await storage.getUserVote(post.id)

  const moderation = await storage.getModeration(post.id)
  const evald = policy.evaluate(moderation)

  return {
    id: post.id,
    author: post.author,
    username,
    createdAt: post.createdAt || null,
    body: content ? content.body : '',
    commentCount,
    voteCount,
    userVote,
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

  const voteCount = await storage.getVoteCount(postId)
  const userVote = await storage.getUserVote(postId)

  const moderation = await storage.getModeration(postId)
  const evald = policy.evaluate(moderation)

  const comments = await storage.getComments(postId)
  const projectedComments = []
  for (const c of comments) {
    const ident = await storage.getIdentity(c.node.author)
    const username = ident && ident.username ? ident.username : shortKey(c.node.author)

    const commentVoteCount = await storage.getVoteCount(c.node.id)
    const commentUserVote = await storage.getUserVote(c.node.id)

    const commentModeration = await storage.getModeration(c.node.id)
    const evaldComment = policy.evaluate(commentModeration)

    projectedComments.push({
      id: c.node.id,
      author: c.node.author,
      username,
      createdAt: c.node.createdAt || null,
      body: c.content ? c.content.body : '',
      voteCount: commentVoteCount,
      userVote: commentUserVote,
      visible: evaldComment.visible,
      moderation: {
        action: evaldComment.action,
        flags: evaldComment.flags,
        maxFlags: policy.maxFlags
      }
    })
  }

  projectedComments.sort((a, b) => {
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
    voteCount,
    userVote,
    visible: evald.visible,
    moderation: {
      action: evald.action,
      flags: evald.flags,
      maxFlags: policy.maxFlags
    },
    comments: projectedComments
  }
}

async function buildRedditState (storage, contexts, policy, opts = {}) {
  console.log('buildRedditState: starting')
  await storage.graph.update()
  console.log('buildRedditState: graph updated')

  const threadId = opts.thread || null

  console.log('buildRedditState: listing posts...')
  const posts = await storage.listPosts()
  console.log('buildRedditState: found', posts.length, 'posts')
  
  const projectedPosts = []
  for (const p of posts) {
    console.log('buildRedditState: projecting post', p.id)
    projectedPosts.push(await projectPost(storage, policy, p))
  }
  console.log('buildRedditState: projected all posts')

  projectedPosts.sort((a, b) => b.voteCount - a.voteCount)

  const mePubkey = storage.graph.key ? storage.graph.key.toString('hex') : null
  const meIdent = mePubkey ? await storage.getIdentity(mePubkey) : null
  const meModPubkey = (storage.moderationKeyPair && storage.moderationKeyPair.publicKey)
    ? storage.moderationKeyPair.publicKey.toString('hex')
    : null
  const isModerator = meModPubkey ? policy.trustedModeratorKeys.has(meModPubkey) : false

  const thread = threadId ? await projectThread(storage, policy, threadId) : null

  console.log('buildRedditState: returning state')
  return {
    me: {
      pubkey: mePubkey,
      username: meIdent && meIdent.username ? meIdent.username : null,
      isModerator,
      moderationPubkey: meModPubkey
    },
    reddit: {
      contexts: {
        comments: contexts.comments,
        votes: contexts.votes,
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
  buildRedditState,
  RedditPolicy
}
