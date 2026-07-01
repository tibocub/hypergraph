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

    this.keyPair = opts.keyPair || crypto.keyPair()
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
      keyPair: this.keyPair,
      context: this.commentsContext
    })

    return comment
  }

  async vote (targetId, value) {
    console.log('=== VOTE START ===')
    console.log('Storage.vote called with targetId:', targetId, 'value:', value)
    const userKey = this.graph.key.toString('hex')
    
    // Create a vote node (like forum-web creates comment nodes)
    const voteNode = await this.graph.put({ type: 'vote' })
    console.log('Vote node created:', voteNode.id)
    
    // Relate the vote node to the target (like forum-web relates comments to posts)
    console.log('Creating edge from', voteNode.id, 'to', targetId, 'with context', this.votesContext)
    const edge = await this.graph.relate({
      from: voteNode.id,
      to: targetId,
      type: 'vote',
      value,
      author: userKey,
      keyPair: this.keyPair,
      context: this.votesContext
    })
    console.log('Edge created, edge object:', edge)
    
    // Verify vote was saved
    console.log('Calling graph.update()...')
    await this.graph.update()
    console.log('graph.update() completed')
    
    // Check ALL edges in the graph
    console.log('=== CHECKING ALL EDGES ===')
    let totalEdges = 0
    for await (const e of this.graph.edges()) {
      totalEdges++
      if (totalEdges <= 10) {
        console.log('Edge', totalEdges, ':', e.type, e.from, '->', e.to, 'context:', e.context)
      }
    }
    console.log('Total edges in graph:', totalEdges)
    
    // Check edges from vote node (outgoing)
    console.log('=== CHECKING OUTGOING EDGES FROM VOTE NODE ===')
    let outgoingCount = 0
    for await (const e of this.graph.edges(voteNode.id, { direction: 'out' })) {
      outgoingCount++
      console.log('Outgoing edge:', e.type, e.from, '->', e.to, 'value:', e.value, 'context:', e.context)
    }
    console.log('Outgoing edges from vote node:', outgoingCount)
    
    // Check edges to target (incoming)
    console.log('=== CHECKING INCOMING EDGES TO TARGET ===')
    let incomingCount = 0
    for await (const e of this.graph.edges(targetId, { direction: 'in' })) {
      incomingCount++
      console.log('Incoming edge:', e.type, e.from, '->', e.to, 'value:', e.value, 'context:', e.context)
    }
    console.log('Incoming edges to target:', incomingCount)
    
    // Check vote edges specifically
    console.log('=== CHECKING VOTE EDGES TO TARGET ===')
    let voteEdgeFound = false
    for await (const e of this.graph.edges(targetId, { direction: 'in', type: 'vote' })) {
      console.log('Found vote edge:', e.from, '->', e.to, 'value:', e.value, 'context:', e.context)
      voteEdgeFound = true
    }
    console.log('Vote edge found:', voteEdgeFound)
    
    const count = await this.getVoteCount(targetId)
    console.log('Vote count after voting:', count)
    console.log('=== VOTE END ===')
  }

  async getVoteCount (targetId) {
    let count = 0
    for await (const e of this.graph.edges(targetId, { direction: 'in', type: 'vote' })) {
      count += e.value || 0
    }
    return count
  }

  async getUserVote (targetId) {
    const userKey = this.graph.key.toString('hex')
    for await (const e of this.graph.edges(targetId, { direction: 'in', type: 'vote' })) {
      if (e.author === userKey) {
        return e.value || 0
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
        comments.push({ node, content, relationId: e.id })
      }
    }
    return comments
  }
}
