const { Readable } = require('streamx')

/**
 * GraphQuery provides a fluent query builder for graph operations.
 *
 * Allows chaining filter, traversal, and result methods to build complex queries
 * over the graph view. Supports async iteration for lazy evaluation.
 */
module.exports = class GraphQuery {
  #view
  #filters
  #limit
  #reverse
  #traverse

  /**
   * Create a new GraphQuery instance.
   *
   * @param {Object} view - The GraphView instance to query
   * @param {Object} [opts] - Query options
   * @param {Function} [opts.filter] - Initial filter function
   * @param {number} [opts.limit] - Maximum number of results
   * @param {boolean} [opts.reverse] - Whether to reverse results
   * @param {Object} [opts.traverse] - Traversal configuration
   */
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

  /**
   * Add a custom filter function.
   *
   * @param {Function} fn - Filter function that receives a node and returns boolean
   * @returns {GraphQuery} This query instance for chaining
   */
  filter (fn) {
    this.#filters.push(fn)
    return this
  }

  /**
   * Filter by entity type.
   *
   * @param {string} type - The entity type to filter by
   * @returns {GraphQuery} This query instance for chaining
   */
  type (type) {
    this.#filters.push(node => node.type === type)
    return this
  }

  /**
   * Filter by author (hex public key).
   *
   * @param {string} author - The author's hex public key
   * @returns {GraphQuery} This query instance for chaining
   */
  author (author) {
    this.#filters.push(node => node.author === author)
    return this
  }

  /**
   * Filter by tag.
   *
   * @param {string} tag - The tag to filter by
   * @returns {GraphQuery} This query instance for chaining
   *
   * @note Current implementation performs a database scan for each node.
   * Future optimization: pre-filter nodes using the tag index before applying
   * other filters. This would require restructuring filter execution order.
   */
  tag (tag) {
    this.#filters.push((node) => this.#view.hasTag(node.id, tag))
    return this
  }

  // ========================================
  // Traversal Methods
  // ========================================

  /**
   * Traverse outgoing edges of a specific relation type.
   *
   * @param {string} relationType - The relation type to traverse
   * @returns {GraphQuery} This query instance for chaining
   */
  out (relationType) {
    this.#traverse = { direction: 'out', type: relationType }
    return this
  }

  /**
   * Traverse incoming edges of a specific relation type.
   *
   * @param {string} relationType - The relation type to traverse
   * @returns {GraphQuery} This query instance for chaining
   */
  in (relationType) {
    this.#traverse = { direction: 'in', type: relationType }
    return this
  }

  // ========================================
  // Result Methods
  // ========================================

  /**
   * Limit the number of results.
   *
   * @param {number} n - Maximum number of results to return
   * @returns {GraphQuery} This query instance for chaining
   */
  limit (n) {
    this.#limit = n
    return this
  }

  /**
   * Reverse the order of results.
   *
   * @returns {GraphQuery} This query instance for chaining
   */
  reverse () {
    this.#reverse = !this.#reverse
    return this
  }

  // ========================================
  // Execution
  // ========================================

  async * [Symbol.asyncIterator] () {
    const countRef = { value: 0 }

    // Determine source stream based on filters
    let source = this.#getSourceStream()

    for await (const node of source) {
      if (countRef.value >= this.#limit) break

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
          yield * this.#traverseEdges(node, countRef)
        } else {
          yield node
          countRef.value++
        }
      }
    }
  }

  async * #getSourceStream () {
    // Default: scan all nodes
    // The filters will be applied in the main iterator
    const stream = this.#view.createReadStream({
      gte: 'n:',
      lt: 'n:\uffff',
      reverse: this.#reverse
    })

    for await (const entry of stream) {
      const value = /** @type {any} */ (entry).value
      if (!value.deleted) {
        yield value
      }
    }
  }

  async * #traverseEdges (node, countRef) {
    if (!this.#traverse) {
      yield node
      return
    }

    const edges = this.#view.getEdges(node.id, {
      direction: this.#traverse.direction,
      type: this.#traverse.type
    })

    for await (const edge of edges) {
      if (countRef.value >= this.#limit) break

      const targetId = this.#traverse.direction === 'out' ? edge.to : edge.from
      const target = await this.#view.getNode(targetId)
      if (target) {
        yield { ...target, relation: edge }
        countRef.value++
      }
    }
  }

  // ========================================
  // Convenience Methods
  // ========================================

  /**
   * Execute the query and return all results as an array.
   *
   * @returns {Promise<Array<any>>} Array of query results
   */
  async toArray () {
    const results = []
    for await (const item of this) {
      results.push(item)
    }
    return results
  }

  /**
   * Execute the query and return only the first result.
   *
   * @returns {Promise<Object|null>} The first result, or null if no results
   */
  async first () {
    for await (const item of this) {
      return item
    }
    return null
  }

  /**
   * Execute the query and count the results.
   *
   * @returns {Promise<number>} The number of results
   */
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

  /**
   * Create a readable stream of query results.
   *
   * @returns {Object} A readable stream that emits query results
   */
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
