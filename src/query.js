const { Readable } = require('streamx')
const safetyCatch = require('safety-catch')

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
  #typeFilter
  #sortField
  #sortDirection
  #graph

  /**
   * Create a new GraphQuery instance.
   *
   * @param {Object} view - The GraphView instance to query
   * @param {Object} [opts] - Query options
   * @param {Function} [opts.filter] - Initial filter function
   * @param {number} [opts.limit] - Maximum number of results
   * @param {boolean} [opts.reverse] - Whether to reverse results
   * @param {Object} [opts.traverse] - Traversal configuration
   * @param {Object} [graph] - The Hypergraph instance this query came from,
   *   needed for live() to subscribe to its 'change' events. Optional —
   *   only live() requires it; everything else works without it.
   */
  constructor (view, opts = {}, graph = null) {
    this.#view = view
    this.#filters = opts.filter ? [opts.filter] : []
    this.#limit = opts.limit || Infinity
    this.#reverse = opts.reverse || false
    this.#traverse = opts.traverse || null
    this.#typeFilter = null
    this.#sortField = null
    this.#sortDirection = 'asc'
    this.#graph = graph
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
   * Filter by entity type. Also selects the type-specific, chronologically
   * ordered index (nt:<type>:<createdAt>:<id>) for the underlying scan,
   * instead of the generic unordered one — see #getSourceStream().
   *
   * @param {string} type - The entity type to filter by
   * @returns {GraphQuery} This query instance for chaining
   */
  type (type) {
    this.#typeFilter = type
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

  /**
   * Sort results by an arbitrary field, in memory. Unlike the default
   * chronological order (which uses a real index and streams lazily),
   * this buffers all matching results before yielding — necessary since
   * there's no way to index a field that isn't stored on the entity
   * itself (e.g. a derived vote count computed from edges). Fine for a
   * single page's worth of results; not meant for huge collections.
   *
   * @param {string} field - The field to sort by (read directly off each result)
   * @param {'asc'|'desc'} [direction='asc'] - Sort direction
   * @returns {GraphQuery} This query instance for chaining
   */
  sortBy (field, direction = 'asc') {
    this.#sortField = field
    this.#sortDirection = direction === 'desc' ? 'desc' : 'asc'
    return this
  }

  // ========================================
  // Execution
  // ========================================

  async * [Symbol.asyncIterator] () {
    if (this.#sortField) {
      yield * this.#collectSorted()
      return
    }

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

  async * #collectSorted () {
    // The real limit is applied after sorting, via slice() below — the
    // collection pass itself must see every matching result, so traversal
    // (which reads this.#limit directly) is given an effectively
    // unbounded count here.
    const unboundedCount = { value: 0 }
    const all = []

    for await (const node of this.#getSourceStream()) {
      let matches = true
      for (const filter of this.#filters) {
        const result = await filter(node)
        if (!result) {
          matches = false
          break
        }
      }

      if (!matches) continue

      if (this.#traverse) {
        const savedLimit = this.#limit
        this.#limit = Infinity
        try {
          for await (const item of this.#traverseEdges(node, unboundedCount)) {
            all.push(item)
          }
        } finally {
          this.#limit = savedLimit
        }
      } else {
        all.push(node)
      }
    }

    const field = this.#sortField
    const dir = this.#sortDirection === 'desc' ? -1 : 1
    all.sort((a, b) => {
      const av = a[field]
      const bv = b[field]
      if (av === bv) return 0
      if (av === undefined || av === null) return 1
      if (bv === undefined || bv === null) return -1
      return (av < bv ? -1 : 1) * dir
    })

    const limited = this.#limit === Infinity ? all : all.slice(0, this.#limit)
    yield * limited
  }

  async * #getSourceStream () {
    // Prefer an index that's actually ordered by creation time, instead of
    // the generic n: prefix this used to scan — that one is keyed by
    // (type, authorCoreKeyHex, seq), which is not chronological at all
    // once more than one author is involved, since a core key's hex
    // ordering has nothing to do with when its owner actually wrote
    // something (confirmed directly: a newer post from one author can
    // sort before an older post from another purely because of key
    // ordering). nc: covers the same full set of entities as the old n:
    // scan did, just chronologically ordered instead.
    const prefix = this.#typeFilter ? `nt:${this.#typeFilter}:` : 'nc:'

    const stream = this.#view.createReadStream({
      gte: prefix,
      lt: prefix + '\uffff',
      reverse: this.#reverse
    })

    for await (const entry of stream) {
      const { id } = /** @type {any} */ (entry).value
      const node = await this.#view.getNode(id)
      // getNode() already excludes deleted entities and returns null for
      // anything it can't resolve.
      if (node) yield node
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

  /**
   * Run this query now, then re-run it and invoke callback again whenever
   * new data arrives on the graph — whether from a local write or data
   * that arrived via replication (see Hypergraph.update()'s 'change'
   * event). Re-runs are debounced (coalescing a burst of several changes,
   * e.g. a put() + putContent() + tag() in quick succession, into a
   * single re-run) rather than firing once per individual change.
   *
   * This re-runs the whole query on every relevant change rather than
   * incrementally diffing results — the simpler, correct-first approach,
   * consistent with this being a new feature; worth revisiting only if
   * this specific cost becomes a real bottleneck in practice.
   *
   * @param   {Function} callback - Called with the full result array, once immediately and again after each change
   * @param   {Object}   [opts]
   * @param   {number}   [opts.debounceMs=50] - How long to wait for more changes before re-running
   * @returns {Function} Unsubscribe function — stops listening and cancels any pending debounced re-run
   * @throws  {Error} If this query wasn't created via graph.query() (no graph reference to subscribe to)
   */
  live (callback, opts = {}) {
    if (!this.#graph) throw new Error('live() requires a query created via graph.query()')
    const debounceMs = typeof opts.debounceMs === 'number' ? opts.debounceMs : 50

    let running = false
    let rerunQueued = false
    let debounceTimer = null
    let stopped = false

    const runOnce = async () => {
      if (running) {
        rerunQueued = true
        return
      }
      running = true
      try {
        const results = await this.toArray()
        if (!stopped) callback(results)
      } catch (err) {
        // A failing query or a throwing callback shouldn't kill the
        // subscription — future changes should still trigger a retry.
        safetyCatch(err)
      } finally {
        running = false
        if (rerunQueued && !stopped) {
          rerunQueued = false
          runOnce()
        }
      }
    }

    const onChange = () => {
      if (stopped) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        runOnce()
      }, debounceMs)
    }

    this.#graph.on('change', onChange)
    runOnce() // initial snapshot, immediate — no debounce on the first run

    return () => {
      stopped = true
      if (debounceTimer) clearTimeout(debounceTimer)
      this.#graph.off('change', onChange)
    }
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
