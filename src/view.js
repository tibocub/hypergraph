const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const { toSortableTs } = require('./utils')

/**
 * GraphView manages the materialized view for graph operations.
 *
 * Maintains indexes over user cores and contexts to provide efficient queries
 * for entities, edges, tags, and content. Updates incrementally as new events
 * are processed.
 *
 * @extends ReadyResource
 */
module.exports = class GraphView extends ReadyResource {
  #bee
  #userCores
  #contexts
  #lastProcessedSeq
  #contextCheckpoints
  #userMetaKey
  #deviceToIdentity // Maps device key hex -> identity key hex

  /**
   * Create a new GraphView instance.
   *
   * @param {Object} bee - The Hyperbee instance for the view
   * @param {Map} userCores - Map of user core keys to UserCore instances
   * @param {Map} contexts - Map of context names to ContextBase instances
   */
  constructor (bee, userCores, contexts) {
    super()

    this.#bee = bee
    this.#userCores = userCores
    this.#contexts = contexts
    this.#lastProcessedSeq = new Map()
    this.#contextCheckpoints = new Map()
    this.#userMetaKey = null
    this.#deviceToIdentity = new Map()

    this.ready().catch(safetyCatch)
  }

  /**
   * Register a device-to-identity mapping for multi-device support.
   *
   * @param {string} deviceKeyHex - Hex-encoded device public key
   * @param {string} identityKeyHex - Hex-encoded identity public key
   */
  registerDeviceIdentity (deviceKeyHex, identityKeyHex) {
    this.#deviceToIdentity.set(deviceKeyHex, identityKeyHex)
  }

  /**
   * Get the identity key for a device key.
   *
   * @param {string} deviceKeyHex - Hex-encoded device public key
   * @returns {string|null} The identity key hex, or null if not found
   */
  getIdentityForDevice (deviceKeyHex) {
    return this.#deviceToIdentity.get(deviceKeyHex) || null
  }

  /**
   * Get the identity profile for a public key.
   *
   * @param {string} pubkey - Hex-encoded public key
   * @returns {Promise<Object|null>} The identity profile, or null if not found
   */
  async getIdentity (pubkey) {
    if (!this.opened) await this.ready()
    const entry = await this.#bee.get(`id:profile:${pubkey}`)
    return entry ? entry.value : null
  }

  async _open () {
    for (const [keyHex, core] of this.#userCores) {
      if (!core.key) throw new Error('UserCore key missing')
      const metaKey = `meta:user:${keyHex}:lastSeq`
      const meta = await this.#bee.get(metaKey)
      this.#lastProcessedSeq.set(keyHex, meta ? meta.value.seq : -1)
    }
  }

  async _close () {
    // Nothing to close, bee is managed by Hypergraph
  }

  /** @returns {Object} The underlying Hyperbee instance */
  get bee () {
    return this.#bee
  }

  // ========================================
  // Update View
  // ========================================

  /**
   * Update the view by processing new events from user cores and contexts.
   *
   * @returns {Promise<void>}
   */
  async update () {
    if (!this.opened) await this.ready()

    // Ensure replicated data is pulled in before indexing
    for (const [keyHex, core] of this.#userCores) {
      await core.update()

      const lastSeq = this.#lastProcessedSeq.get(keyHex) ?? -1
      const currentLength = core.length
      if (currentLength <= lastSeq + 1) continue

      for (let i = lastSeq + 1; i < currentLength; i++) {
        const event = await core.get(i)
        await this.#applyEvent(event, i, keyHex)
      }

      const nextSeq = currentLength - 1
      this.#lastProcessedSeq.set(keyHex, nextSeq)
      await this.#bee.put(`meta:user:${keyHex}:lastSeq`, { seq: nextSeq })
    }

    // Context autobases update themselves via their apply function
    // We just need to ensure they're synced
    for (const [, context] of this.#contexts) {
      if (!context.opened) continue

      const viewCore = context.view?.core
      if (!viewCore) continue

      const viewKeyHex = viewCore.key.toString('hex')
      const metaKey = `meta:contextView:${viewKeyHex}:length`

      // If we have not loaded the checkpoint for this view yet, load it lazily.
      if (!this.#contextCheckpoints.has(viewKeyHex)) {
        const v = await this.#bee.get(metaKey)
        this.#contextCheckpoints.set(viewKeyHex, v ? v.value.length : -1)
      }

      const lastIndexedLen = this.#contextCheckpoints.get(viewKeyHex)
      const viewLen = viewCore.length
      const baseLen = context.core?.length ?? -1

      // Skip update if Autobase core and view core are in sync and we already indexed this length.
      if (baseLen !== -1 && viewLen === baseLen && viewLen === lastIndexedLen) continue

      await context.update()

      const nextViewLen = viewCore.length
      this.#contextCheckpoints.set(viewKeyHex, nextViewLen)
      await this.#bee.put(metaKey, { length: nextViewLen })
    }
  }

  async #applyEvent (event, seq, coreKeyHex) {
    switch (event.type) {
      case 'entity/create':
        await this.#applyEntityCreate(event, seq, coreKeyHex)
        break
      case 'entity/tombstone':
        await this.#applyEntityTombstone(event, coreKeyHex)
        break
      case 'content/append':
        await this.#applyContentAppend(event, seq)
        break
      case 'identity/update':
        await this.#applyIdentityUpdate(event, seq, coreKeyHex)
        break
    }
  }

  async #applyIdentityUpdate (event, seq, coreKeyHex) {
    if (event.author !== coreKeyHex) return

    const key = `id:profile:${event.author}`
    await this.#bee.put(key, {
      author: event.author,
      username: event.username,
      bio: event.bio || null,
      seq
    })
  }

  async #applyEntityCreate (event, seq, coreKeyHex) {
    // Binding invariant: entities are authored by the owner of the core they live in.
    if (event.author !== coreKeyHex) return

    const derivedId = `${event.entityType}/${coreKeyHex}/${seq}`

    const key = `n:${derivedId}`
    const existing = await this.#bee.get(key)

    // Entities are immutable once created.
    // If it already exists, ignore subsequent creates.
    if (existing && !existing.value.deleted) return

    await this.#bee.put(key, {
      id: derivedId,
      type: event.entityType,
      author: event.author,
      createdAt: event.timestamp,
      deleted: false,
      version: seq
    })

    // Type index (time sortable): nt:<type>:<createdAt>:<id>
    // This is a secondary index to make by-type scans efficient.
    const typeKey = `nt:${event.entityType}:${toSortableTs(event.timestamp)}:${derivedId}`
    await this.#bee.put(typeKey, { id: derivedId })
  }

  async #applyEntityTombstone (event, coreKeyHex) {
    // Binding invariant: only the owner of the core can tombstone entities in that core.
    if (event.author !== coreKeyHex) return

    // V1: tombstone ids are expected to already be in derived form.
    // If not, ignore to avoid deleting an ambiguous/legacy id.
    if (typeof event.id !== 'string' || !event.id.includes(`/${coreKeyHex}/`)) return

    const key = `n:${event.id}`
    const existing = await this.#bee.get(key)

    if (existing) {
      await this.#bee.put(key, {
        ...existing.value,
        deleted: true,
        deletedAt: event.timestamp,
        deletedBy: event.author
      })
    }
  }

  async #applyContentAppend (event, seq) {
    const key = `c:${event.entityId}:${seq}`
    await this.#bee.put(key, {
      entityId: event.entityId,
      contentType: event.contentType,
      body: event.body,
      createdAt: event.timestamp
    })
  }

  /**
   * Add a user core to the view.
   *
   * @param {string} keyHex - Hex-encoded public key of the user core
   * @param {Object} userCore - The UserCore instance
   * @returns {void}
   */
  addUserCore (keyHex, userCore) {
    this.#userCores.set(keyHex, userCore)
    // Initialize checkpoint lazily
    this.ready().then(async () => {
      const metaKey = `meta:user:${keyHex}:lastSeq`
      const meta = await this.#bee.get(metaKey)
      if (!this.#lastProcessedSeq.has(keyHex)) {
        this.#lastProcessedSeq.set(keyHex, meta ? meta.value.seq : -1)
      }
    })
  }

  // ========================================
  // Context Management
  // ========================================

  /**
   * Add a context to the view.
   *
   * @param {string} name - The context name/identifier
   * @param {Object} context - The ContextBase instance
   * @returns {void}
   */
  addContext (name, context) {
    this.#contexts.set(name, context)

    // Initialize checkpoint tracking for newly added contexts.
    // Context keys are only available once the context is ready.
    this.ready().then(async () => {
      if (!context.opened) await context.ready()
      const viewCore = context.view?.core
      if (!viewCore) return

      const viewKeyHex = viewCore.key.toString('hex')
      if (this.#contextCheckpoints.has(viewKeyHex)) return

      const metaKey = `meta:contextView:${viewKeyHex}:length`
      const v = await this.#bee.get(metaKey)
      this.#contextCheckpoints.set(viewKeyHex, v ? v.value.length : -1)
    })
  }

  // ========================================
  // Read Operations
  // ========================================

  /**
   * Get a node (entity) by its ID.
   *
   * @param {string} id - The entity ID
   * @returns {Promise<Entity|null>} The entity, or null if not found or deleted
   */
  async getNode (id) {
    if (!this.opened) await this.ready()

    const entry = await this.#bee.get(`n:${id}`)
    if (!entry || entry.value.deleted) {
      return null
    }
    return entry.value
  }

  /**
   * Get the latest content version for an entity.
   *
   * @param {string} entityId - The entity ID
   * @returns {Promise<{ contentType: string, body: string }|null>} The content, or null if not found
   */
  async getContent (entityId) {
    if (!this.opened) await this.ready()

    // Get latest content for entity
    const stream = this.#bee.createReadStream({
      gte: `c:${entityId}:`,
      lt: `c:${entityId}:\uffff`,
      reverse: true,
      limit: 1
    })

    for await (const entry of stream) {
      return entry.value
    }

    return null
  }

  /**
   * Get edges for an entity.
   *
   * @param {string} entityId - The entity ID
   * @param {EdgeQueryOpts} [opts] - Query options
   * @returns {AsyncIterable<Edge>} Async iterator of edges
   */
  async * getEdges (entityId, opts = {}) {
    if (!this.opened) await this.ready()

    const direction = opts.direction || 'out'
    const type = opts.type
    const limit = typeof opts.limit === 'number' ? opts.limit : null
    const order = opts.order
    const reverse = typeof opts.reverse === 'boolean'
      ? opts.reverse
      : (order === 'desc')

    // Query from all context views
    for (const [name, context] of this.#contexts) {
      if (!context.opened) continue

      if (direction === 'out') {
        // Outgoing edges: e:<from>:<type>:<to>
        const prefix = type
          ? `e:${entityId}:${type}:`
          : `e:${entityId}:`

        const stream = context.view.createReadStream({
          gte: prefix,
          lt: prefix + '\uffff',
          reverse,
          limit: limit || undefined
        })

        for await (const entry of stream) {
          if (!entry.value.deleted) {
            yield entry.value
          }
        }
      } else {
        // Incoming edges: i:in:<to>:<type>:<from>
        const prefix = type
          ? `i:in:${entityId}:${type}:`
          : `i:in:${entityId}:`

        const stream = context.view.createReadStream({
          gte: prefix,
          lt: prefix + '\uffff',
          reverse,
          limit: limit || undefined
        })

        for await (const entry of stream) {
          // Get the actual edge data
          const edgeKey = entry.value.ref
          const edge = await context.view.get(edgeKey)
          if (edge && !edge.value.deleted) {
            yield edge.value
          }
        }
      }
    }
  }

  /**
   * Get entities by tag from context views.
   *
   * @param {string} tag - The tag to search for
   * @param {Object} [opts] - Query options
   * @param {string} [opts.author] - Filter by a single author (hex public key)
   * @param {string[]} [opts.authors] - Filter by multiple authors (hex public keys)
   * @returns {AsyncIterable<Entity>} Async iterator of entities with the tag
   */
  async * getByTag (tag, opts = {}) {
    if (!this.opened) await this.ready()

    const authors = opts.authors || (opts.author ? [opts.author] : null)
    const allow = authors ? new Set(authors) : null

    // Query from all context views
    for (const [name, context] of this.#contexts) {
      if (!context.opened) continue

      const prefix = `t:${tag}:`
      const stream = context.view.createReadStream({
        gte: prefix,
        lt: prefix + '\uffff'
      })

      for await (const entry of stream) {
        if (!entry.key.startsWith(prefix)) continue
        if (allow && !allow.has(entry.value.author)) continue
        const node = await this.getNode(entry.value.entityId)
        if (node && node.author === entry.value.author) {
          yield { ...node, tag: entry.value.tag }
        }
      }
    }
  }

  /**
   * Get entities by type from the view.
   *
   * @param {string} type - The entity type to filter by (use '*' or null for all types)
   * @returns {AsyncIterable<Entity>} Async iterator of entities with the type
   */
  async * getByType (type) {
    if (!this.opened) await this.ready()

    // Legacy fallback: allow '*' to mean "all nodes"
    if (type === '*' || type == null) {
      const stream = this.#bee.createReadStream({
        gte: 'n:',
        lt: 'n:\uffff'
      })

      for await (const entry of stream) {
        if (!entry.value.deleted) {
          yield entry.value
        }
      }

      return
    }

    // Use type index (time sortable)
    const prefix = `nt:${type}:`
    const stream = this.#bee.createReadStream({
      gte: prefix,
      lt: prefix + '\uffff'
    })

    for await (const entry of stream) {
      const node = await this.getNode(entry.value.id)
      if (node) yield node
    }
  }

  /**
   * Get entities by author (hex public key).
   *
   * Note: This is O(n) as it scans all nodes. Could be optimized with an author index.
   *
   * @param {string} author - The author's hex public key
   * @returns {AsyncIterable<Entity>} Async iterator of entities by the author
   */
  async * getByAuthor (author) {
    if (!this.opened) await this.ready()

    // Scan all nodes and filter by author
    // This is O(n) - could be optimized with an author index
    const stream = this.#bee.createReadStream({
      gte: 'n:',
      lt: 'n:\uffff'
    })

    for await (const entry of stream) {
      if (!entry.value.deleted && entry.value.author === author) {
        yield entry.value
      }
    }
  }

  /**
   * Create a readable stream from the underlying Hyperbee.
   *
   * @param {Object} [opts] - Stream options (passed to Hyperbee.createReadStream)
   * @returns {AsyncIterable<Object>} Async iterator of view entries
   */
  async * createReadStream (opts = {}) {
    if (!this.opened) await this.ready()
    yield * this.#bee.createReadStream(opts)
  }

  // ========================================
  // Raw Access
  // ========================================

  /**
   * Get a raw value from the Hyperbee by key.
   *
   * @param {string} key - The key to look up
   * @returns {Promise<Object|null>} The value, or null if not found
   */
  async get (key) {
    if (!this.opened) await this.ready()
    return this.#bee.get(key)
  }

  /**
   * Put a raw value into the Hyperbee.
   *
   * @param {string} key - The key to set
   * @param {Object} value - The value to store
   * @returns {Promise<void>}
   */
  async put (key, value) {
    if (!this.opened) await this.ready()
    return this.#bee.put(key, value)
  }
}
