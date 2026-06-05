function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

module.exports = class ConsoleUI {
  constructor (storage, policy) {
    this.storage = storage
    this.policy = policy
  }

  async printPosts () {
    const posts = await this.storage.listPosts()
    console.log(`Posts (${posts.length}):`)

    for (const p of posts) {
      const identity = await this.storage.getIdentity(p.author)
      const author = identity && identity.username ? identity.username : shortKey(p.author)
      const content = await this.storage.graph.getContent(p.id)
      const body = content ? content.body : ''
      console.log(`- ${p.id} by ${author}`)
      if (body) console.log(`  ${body}`)
    }
  }

  async printThread (postId) {
    const post = await this.storage.graph.get(postId)
    if (!post) {
      console.log('Post not found:', postId)
      return
    }

    const postIdentity = await this.storage.getIdentity(post.author)
    const postAuthor = this.storage.displayAuthor(post.author, postIdentity)
    const postContent = await this.storage.graph.getContent(post.id)

    const mod = await this.storage.getModeration(post.id, {
      authors: [...this.policy.trustedModeratorKeys]
    })

    const show = this.policy.shouldShow(mod)

    console.log(`\nThread: ${post.id}`)
    console.log(`Author: ${postAuthor}`)

    if (!show) {
      console.log('[hidden by policy]')
      return
    }

    if (postContent) console.log(postContent.body)

    const replies = await this.storage.getReplies(post.id)
    console.log(`\nReplies (${replies.length}):`)
    for (const r of replies) {
      const identity = await this.storage.getIdentity(r.node.author)
      const author = this.storage.displayAuthor(r.node.author, identity)
      console.log(`- ${r.node.id} by ${author}`)
      console.log(`  ${r.content.body}`)
    }
  }
}
