const { Readable } = require('streamx')

module.exports = class GraphQuery {
  #view
  #filters
  #limit
  #reverse
  #traverse

  constructor (view, opts = {}) {
    this.#view = view
    this.#filters = opts.filter ? [opts.filter] : []
    this.#limit = opts.limit || Infinity
    this.#reverse = opts.reverse || false
    this.#traverse = opts.traverse || null
  }

  // ========================================
  // Filter Methods
  // ========================================

  filter (fn) {
    this.#filters.push(fn)
    return this
  }

  type (type) {
    this.#filters.push(node => node.type === type)
    return this
  }

  author (author) {
    this.#filters.push(node => node.author === author)
    return this
  }

  tag (tag) {
    this.#filters.push(async (node) => {
      // Check if node has this tag
      const prefix = `tref:${tag}:${node.id}:`
      const stream = this.#view.createReadStream({
        gte: prefix,
        lt: prefix + '\uffff',
        limit: 1
      })

      for await (const entry of stream) {
        if (entry && entry.key && entry.key.startsWith(prefix)) return true
      }

      return false
    })
    return this
  }

  // ========================================
  // Traversal Methods
  // ========================================

  out (relationType) {
    this.#traverse = { direction: 'out', type: relationType }
    return this
  }

  in (relationType) {
    this.#traverse = { direction: 'in', type: relationType }
    return this
  }

  // ========================================
  // Result Methods
  // ========================================

  limit (n) {
    this.#limit = n
    return this
  }

  reverse () {
    this.#reverse = !this.#reverse
    return this
  }

  // ========================================
  // Execution
  // ========================================

  async * [Symbol.asyncIterator] () {
    let count = 0

    // Determine source stream based on filters
    let source = this.#getSourceStream()

    for await (const node of source) {
      if (count >= this.#limit) break

      // Apply filters
      let matches = true
      for (const filter of this.#filters) {
        const result = await filter(node)
        if (!result) {
          matches = false
          break
        }
      }

      if (matches) {
        // Apply traversal if specified
        if (this.#traverse) {
          yield * this.#traverseEdges(node)
        } else {
          yield node
          count++
        }
      }
    }
  }

  async * #getSourceStream () {
    // Default: scan all nodes
    // The filters will be applied in the main iterator
    const stream = this.#view.createReadStream({
      gte: 'n:',
      lt: 'n:\uffff'
    })

    for await (const entry of stream) {
      if (!entry.value.deleted) {
        yield entry.value
      }
    }
  }

  async * #traverseEdges (node) {
    if (!this.#traverse) {
      yield node
      return
    }

    const edges = this.#view.getEdges(node.id, {
      direction: this.#traverse.direction,
      type: this.#traverse.type
    })

    for await (const edge of edges) {
      const targetId = this.#traverse.direction === 'out' ? edge.to : edge.from
      const target = await this.#view.getNode(targetId)
      if (target) {
        yield { ...target, relation: edge }
      }
    }
  }

  // ========================================
  // Convenience Methods
  // ========================================

  async toArray () {
    const results = []
    for await (const item of this) {
      results.push(item)
    }
    return results
  }

  async first () {
    for await (const item of this) {
      return item
    }
    return null
  }

  async count () {
    let count = 0
    for await (const _ of this) {
      count++
    }
    return count
  }

  // ========================================
  // Stream Interface
  // ========================================

  createReadStream () {
    const self = this
    return new Readable({
      async read () {
        try {
          for await (const item of self) {
            this.push(item)
          }
          this.push(null)
        } catch (err) {
          this.destroy(err)
        }
      }
    })
  }
}
