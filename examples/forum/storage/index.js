const crypto = require('hypercore-crypto')

function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

function parseDeterministicId (id) {
  // <type>/<coreKeyHex>/<seq>
  const parts = String(id).split('/')
  if (parts.length < 3) return null
  const seq = Number(parts[parts.length - 1])
  const coreKeyHex = parts[parts.length - 2]
  const type = parts.slice(0, parts.length - 2).join('/')
  return { type, coreKeyHex, seq }
}

module.exports = class ForumStorage {
  constructor (graph, opts = {}) {
    this.graph = graph
    this.commentsContext = opts.commentsContext
    this.moderationContext = opts.moderationContext

    this.moderationKeyPair = opts.moderationKeyPair || crypto.keyPair()
  }

  async setIdentity (profile) {
    return this.graph.setIdentity(profile)
  }

  async getIdentity (pubkey) {
    return this.graph.getIdentity(pubkey)
  }

  async createPost (body) {
    const node = await this.graph.put({ type: 'post' })
    await this.graph.putContent(node.id, body, 'text')
    return node
  }

  async reply (postId, body) {
    const comment = await this.graph.put({ type: 'comment' })
    await this.graph.putContent(comment.id, body, 'text')

    await this.graph.relate({
      from: comment.id,
      to: postId,
      type: 'reply',
      author: this.graph.key.toString('hex'),
      context: this.commentsContext
    })

    return comment
  }

  async moderate (targetId, action, reason) {
    return this.graph.moderateAction({
      context: this.moderationContext,
      action,
      target: targetId,
      reason: reason || null,
      keyPair: this.moderationKeyPair
    })
  }

  async listPosts () {
    const posts = await this.graph.query().type('post').toArray()
    posts.sort((a, b) => {
      const pa = parseDeterministicId(a.id)
      const pb = parseDeterministicId(b.id)
      if (!pa || !pb) return 0
      if (pa.coreKeyHex < pb.coreKeyHex) return -1
      if (pa.coreKeyHex > pb.coreKeyHex) return 1
      return pa.seq - pb.seq
    })
    return posts
  }

  async getReplies (postId) {
    const edges = []
    for await (const e of this.graph.edges(postId, { direction: 'in', type: 'reply' })) edges.push(e)

    const replies = []
    for (const e of edges) {
      const node = await this.graph.get(e.from)
      if (!node) continue
      const content = await this.graph.getContent(node.id)
      if (!content) continue
      replies.push({ node, content, edge: e })
    }

    replies.sort((a, b) => {
      const pa = parseDeterministicId(a.node.id)
      const pb = parseDeterministicId(b.node.id)
      if (!pa || !pb) return 0
      if (pa.coreKeyHex < pb.coreKeyHex) return -1
      if (pa.coreKeyHex > pb.coreKeyHex) return 1
      return pa.seq - pb.seq
    })

    return replies
  }

  async getModeration (targetId, opts = {}) {
    const events = []
    for await (const ev of this.graph.queryContext({
      type: 'moderation',
      context: this.moderationContext,
      target: targetId,
      authors: opts.authors
    })) {
      events.push(ev)
    }
    return events
  }

  displayAuthor (pubkey, identity) {
    if (identity && identity.username) return identity.username
    return shortKey(pubkey)
  }
}
