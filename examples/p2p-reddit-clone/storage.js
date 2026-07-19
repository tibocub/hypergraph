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

module.exports = class RedditStorage {
  constructor (graph, opts = {}) {
    this.graph = graph
    this.commentsContext = opts.commentsContext
    this.votesContext = opts.votesContext
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

  async createComment (postId, body) {
    const comment = await this.graph.put({ type: 'comment' })
    await this.graph.putContent(comment.id, body, 'text')

    await this.graph.relate({
      from: comment.id,
      to: postId,
      type: 'reply',
      context: this.commentsContext
    })

    return comment
  }

  async vote (targetId, value) {
    if (value !== 1 && value !== -1 && value !== 0) {
      throw new Error('vote value must be 1, -1, or 0 (to retract)')
    }

    const voteNode = await this.graph.put({ type: 'vote' })
    await this.graph.relate({
      from: voteNode.id,
      to: targetId,
      type: 'vote',
      value,
      context: this.votesContext
    })
  }

  async getVoteCount (targetId) {
    let count = 0
    // latestPerAuthor: a user may have voted more than once (changed their
    // mind, or a retry) — only their most recent vote should count toward
    // the tally, since there's no other mechanism enforcing one vote per
    // user here.
    for await (const e of this.graph.edges(targetId, { direction: 'in', type: 'vote', latestPerAuthor: true })) {
      // Clamp to the valid range when tallying: relate() can't prevent a
      // peer from writing an out-of-range value at the protocol level in
      // an open-mode context, so malformed votes are ignored here rather
      // than trusted at face value.
      if (e.value === 1 || e.value === -1) count += e.value
    }
    return count
  }

  async getUserVote (targetId) {
    const myPubkey = this.graph.identity.deviceKeyPair.publicKey.toString('hex')
    for await (const e of this.graph.edges(targetId, { direction: 'in', type: 'vote', latestPerAuthor: true })) {
      if (e.author === myPubkey) {
        return (e.value === 1 || e.value === -1) ? e.value : 0
      }
    }
    return 0
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

  async getComments (postId) {
    const comments = []
    for await (const e of this.graph.edges(postId, { direction: 'in', type: 'reply' })) {
      const node = await this.graph.get(e.from)
      if (node) {
        const content = await this.graph.getContent(e.from)
        comments.push({ node, content, relationId: e.id, pending: false })
      } else {
        // The comment's own entity lives in its author's user core, which
        // this peer may not have discovered/opened yet (see
        // announceToReddit()/discoverPeerCores() in peer.js) — the edge
        // itself (and therefore the count) is already visible, but the
        // entity/content isn't resolvable yet. Include a pending
        // placeholder rather than silently dropping it, so the list stays
        // consistent with the count instead of showing fewer comments
        // than actually exist.
        comments.push({ node: null, content: null, relationId: e.id, pending: true })
      }
    }
    return comments
  }
}
