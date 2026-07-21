const ReadyResource = require('ready-resource')
const EventEmitter = require('events')
const safetyCatch = require('safety-catch')
const codecs = require('codecs')
const Hyperbee = require('hyperbee')
const crypto = require('crypto')
const hypercoreCrypto = require('hypercore-crypto')
const sodium = require('sodium-universal')
const b4a = require('b4a')
const UserCore = require('./user-core')
const ContextBase = require('./context-base')
const RoleBase = require('./role-base')
const ScopeBase = require('./scope-base')
const GraphView = require('./view')
const GraphQuery = require('./query')
const IdentityManager = require('./identity-manager')
const { encodeEvent, decodeEvent } = require('./encodings/event')
const { can: canRole } = require('./roles-registry')
const Hypercore = require('hypercore')
const { toSortableTs, stableTagHash } = require('./utils')


/**
 * Minimal graph database optimised for P2P social apps on the Holepunch stack.
 *
 * Hypergraph is a thin composition over Hypercore, Corestore, Autobase and
 * Hyperbee. It exposes a local graph API; networking is the responsibility of
 * the application (typically via Hyperswarm).
 *
 * @class Hypergraph
 * @extends ReadyResource
 * @module hypergraph
 */
module.exports = class Hypergraph extends ReadyResource {
  #store
  #userCore
  #userCores
  #contexts
  #view
  #keyEncoding
  #valueEncoding
  #userCoreKey
  #roleBase
  #scopeBase
  #emitter
  identity

  /**
   * @param {Object} store - Corestore instance for core management
   * @param {HypergraphOpts} [opts] - Configuration options
   */
  constructor (store, opts = {}) {
    super()

    this.#store = store
    this.#keyEncoding = opts.keyEncoding ? codecs(opts.keyEncoding) : null
    this.#valueEncoding = opts.valueEncoding ? codecs(opts.valueEncoding) : null
    this.#userCoreKey = opts.userCoreKey || null
    
    // Initialize identity system
    this.identity = new IdentityManager({
      mnemonic: opts.mnemonic,
      seed: opts.seed,
      identityKey: opts.identity,
      deviceKeyPair: opts.deviceKeyPair
    })
    
    this.#userCore = null
    this.#userCores = new Map()
    this.#contexts = new Map()
    this.#view = null
    this.#roleBase = null
    this.#scopeBase = null
    this.#emitter = new EventEmitter()

    this.ready().catch(safetyCatch)
  }

  async _open () {
    // Initialize identity system
    await this.identity.init()
    
    // Get or create the user's personal core
    // If userCoreKey is provided, open that core (for replication of other devices)
    // Otherwise, use device keyPair for the user core (each device has its own core)
    const deviceKeyPair = this.identity.deviceKeyPair
    const userCoreKey = this.#userCoreKey || (b4a.isBuffer(deviceKeyPair.publicKey) 
      ? deviceKeyPair.publicKey 
      : b4a.from(deviceKeyPair.publicKey))

    this.#userCore = new UserCore(this.#store, {
      key: userCoreKey,
      keyPair: this.#userCoreKey ? null : deviceKeyPair, // No keyPair if opening existing core
      keyEncoding: this.#keyEncoding,
      valueEncoding: this.#valueEncoding
    })
    await this.#userCore.ready()

    const localKeyHex = this.#userCore.key.toString('hex')
    this.#userCores.set(localKeyHex, this.#userCore)

    // Create the view core for indexes
    const viewCore = this.#store.get({ name: 'graph-view' })
    await viewCore.ready()

    // Create Hyperbee for the view
    const viewBee = new Hyperbee(viewCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    await viewBee.ready()

    this.#view = new GraphView(viewBee, this.#userCores, this.#contexts)
    await this.#view.ready()

    // Register device-to-identity mapping for multi-device support
    const identityKeyHex = b4a.isBuffer(this.identity.identityPublicKey)
      ? this.identity.identityPublicKey.toString('hex')
      : String(this.identity.identityPublicKey)
    this.#view.registerDeviceIdentity(localKeyHex, identityKeyHex)
  }

  async _close () {
    if (this.#view) await this.#view.close()
    if (this.#userCore) await this.#userCore.close()

    if (this.#roleBase) await this.#roleBase.close()
    if (this.#scopeBase) await this.#scopeBase.close()

    for (const context of this.#contexts.values()) {
      await context.close()
    }
  }


// ── Getters ──────────────────────────────────────────────────────────────

  /** @returns {Hypercore|undefined} The raw user Hypercore (used for replication). */
  get core () {
    return this.#userCore?.core
  }

  /** @returns {GraphView|null} */
  get view () {
    return this.#view
  }

	/** @returns {Hypercore|undefined} The raw view Hypercore. */
  get viewCore () {
    return this.#view?.bee?.core
  }

	/** @returns {Buffer|undefined} The local user's public key. */
  get key () {
    return this.#userCore?.core?.key
  }

	/** @returns {Buffer|undefined} */
  get discoveryKey () {
    return this.#userCore?.core?.discoveryKey
  }

	/** @returns {RoleBase|null} */
  get roleBase () {
    return this.#roleBase
  }

	/** @returns {ScopeBase|null} */
  get scopeBase () {
    return this.#scopeBase
  }

	/** @returns {Array<PubKeyHex>} UserCore's keys as an array */
  userCoreKeys () {
    return Array.from(this.#userCores.keys()).sort()
  }


// ── Entity operations ─────────────────────────────────────────────────────

  /**
   * Create a new entity.
   *
   * The entity's `id` is derived deterministically as `<type>/<authorHex>/<seq>`
   * after the event is appended to the user core — do **not** pass an `id`.
   *
   * @param   {EntityInput} entity
   * @returns {Promise<Entity>}
   * @throws  {Error} If the user core is read-only or an `id` is provided.
   *
   * @example
   * const { id } = await graph.put({ type: 'post' })
   * // id → 'post/a1b2c3.../0'
   */
  async put (entity) {
    if (!this.opened) await this.ready()
    if (!this.#userCore.writable) throw new Error('User core is read-only')

    const author = this.#userCore.key.toString('hex')

    // Deterministic IDs are assigned after append.
    // Callers must not provide IDs.
    if (entity.id) throw new Error('Entity id must NOT be provided')

    const event = {
      type: 'entity/create',
      id: '',
      entityType: entity.type,
      author,
      timestamp: Date.now()
    }

    const seq = await this.#userCore.append(event)
    const id = `${entity.type}/${author}/${seq}`

    // IDs are derived from (type, coreKeyHex, seq) at read/index time.
    // The event's stored `id` is not used by the view.
    await this.#view.update()
    
    // Emit unified change event
    this.#emitter.emit('change', { 
      type: 'entity-create', 
      id,
      entityType: entity.type,
      author,
      timestamp: Date.now()
    })
    
    return { id, type: entity.type, author }
  }

  /**
   * Fetch an entity by its derived ID.
   *
   * @param   {string} id
   * @returns {Promise<Entity|null>}
   */
  async get (id) {
    if (!this.opened) await this.ready()
    return this.#view.getNode(id)
  }

  /**
   * Soft-delete (tombstone) an entity. Only the original author can do this.
   *
   * @param   {string} id
   * @param   {Object} [opts]
   * @returns {Promise<void>}
   * @throws  {Error} If the entity is not found or the caller is not the author.
   */
  async del (id, opts = {}) {
    if (!this.opened) await this.ready()

    if (!this.#userCore.writable) throw new Error('User core is read-only')

    const node = await this.#view.getNode(id)
    if (!node) throw new Error('Entity not found')

    const author = this.#userCore.key.toString('hex')
    if (node.author !== author) throw new Error('Only the entity author can tombstone it')

    const event = {
      type: 'entity/tombstone',
      id,
      author,
      timestamp: Date.now()
    }

    await this.#userCore.append(event)
    await this.#view.update()
    
    // Emit unified change event
    this.#emitter.emit('change', { 
      type: 'entity-delete', 
      id,
      author,
      timestamp: Date.now()
    })
  }


// ── Content operations ────────────────────────────────────────────────────

  /**
   * Append a new content version to an entity.
   * Content is append-only; use {@link Hypergraph#getContent} to read the latest.
   *
   * @param   {string} entityId
   * @param   {string} content
   * @param   {'text'|string} [contentType='text']
   * @returns {Promise<{ entityId: string, contentType: string, body: string }>}
   */
  async putContent (entityId, content, contentType = 'text', opts = {}) {
    if (!this.opened) await this.ready()

    if (!entityId) throw new Error('entityId is required')

    const node = await this.#view.getNode(entityId)
    if (!node) throw new Error('Entity not found')

    const event = {
      type: 'content/append',
      entityId,
      contentType,
      body: content,
      timestamp: Date.now()
    }

    if (opts.scope) {
      if (!this.#scopeBase) throw new Error('No ScopeBase attached — cannot encrypt content')

      const author = this.identity.deviceKeyPair.publicKey.toString('hex')
      const epoch = await this.#scopeBase.getCurrentEpoch(opts.scope)
      if (epoch === null) throw new Error('Unknown scope')

      const key = await this.#scopeBase.resolveKey(opts.scope, author, this.identity.encryptionKeyPair, epoch)
      if (!key) throw new Error('You do not hold the current key for this scope — cannot encrypt content for it')

      const nonce = hypercoreCrypto.randomBytes(sodium.crypto_secretbox_NONCEBYTES)
      const message = Buffer.from(String(content), 'utf-8')
      const ciphertext = Buffer.alloc(message.length + sodium.crypto_secretbox_MACBYTES)
      sodium.crypto_secretbox_easy(ciphertext, message, nonce, key)

      event.body = ciphertext.toString('hex')
      event.encrypted = true
      event.scope = opts.scope
      event.epoch = epoch
      event.nonce = nonce.toString('hex')
    }

    await this.#userCore.append(event)
    await this.#view.update()
    
    // Emit unified change event
    this.#emitter.emit('change', { 
      type: 'content-append', 
      entityId,
      contentType,
      timestamp: Date.now()
    })
    
    // The caller already has the plaintext they just wrote — always
    // return that, not the ciphertext, regardless of whether this was
    // encrypted for storage.
    return { entityId, contentType, body: content, encrypted: !!opts.scope, scope: opts.scope || null }
  }

  /**
   * Read the latest content version from an entity.
   *
   * If the stored content is encrypted (see putContent()'s opts.scope),
   * this tries to resolve the scope's key locally and decrypt it. If the
   * caller doesn't hold that scope's key for the relevant epoch, this
   * returns a shape with `body: null` and `encrypted: true` rather than
   * throwing or returning garbage — giving the caller a clean way to
   * render "you don't have access" in their UI.
   *
   * @param   {string} entityId
   * @returns {Promise<{ contentType: string, body: string|null, encrypted?: boolean, scope?: string, epoch?: number }|null>}
   */
  async getContent (entityId) {
    if (!this.opened) await this.ready()
    const record = await this.#view.getContent(entityId)
    if (!record) return null
    if (!record.encrypted) return record

    if (!this.#scopeBase) {
      return { contentType: record.contentType, body: null, encrypted: true, scope: record.scope, epoch: record.epoch }
    }

    const author = this.identity.deviceKeyPair.publicKey.toString('hex')
    const key = await this.#scopeBase.resolveKey(record.scope, author, this.identity.encryptionKeyPair, record.epoch)
    if (!key) {
      return { contentType: record.contentType, body: null, encrypted: true, scope: record.scope, epoch: record.epoch }
    }

    try {
      const nonce = b4a.from(record.nonce, 'hex')
      const ciphertext = b4a.from(record.body, 'hex')
      const plaintext = Buffer.alloc(ciphertext.length - sodium.crypto_secretbox_MACBYTES)
      const ok = sodium.crypto_secretbox_open_easy(plaintext, ciphertext, nonce, key)
      if (!ok) return { contentType: record.contentType, body: null, encrypted: true, scope: record.scope, epoch: record.epoch }
      return { contentType: record.contentType, body: plaintext.toString('utf-8'), encrypted: true, scope: record.scope, epoch: record.epoch }
    } catch {
      return { contentType: record.contentType, body: null, encrypted: true, scope: record.scope, epoch: record.epoch }
    }
  }


// ── Identity operations ───────────────────────────────────────────────────

  /**
   * Set the identity profile for the local user.
   *
   * @param   {Object} profile
   * @param   {string} profile.username - The username to set (required)
   * @param   {string} [profile.bio] - Optional bio/description
   * @returns {Promise<Object|null>} The identity profile, or null if not found
   * @throws  {Error} If username is missing or user core is read-only
   */
  async setIdentity (profile = {}) {
    if (!this.opened) await this.ready()
    if (!this.#userCore.writable) throw new Error('User core is read-only')
    if (!profile.username || typeof profile.username !== 'string') throw new Error('username is required')

    const author = this.#userCore.key.toString('hex')
    const event = {
      type: 'identity/update',
      author,
      username: profile.username,
      bio: profile.bio || null,
      timestamp: Date.now()
    }

    await this.#userCore.append(event)
    await this.#view.update()
    return this.getIdentity(author)
  }

  /**
   * Get the identity profile for a public key.
   *
   * @param   {string} pubkey - Hex-encoded public key
   * @returns {Promise<Object|null>} The identity profile, or null if not found
   */
  async getIdentity (pubkey) {
    if (!this.opened) await this.ready()
    return this.#view.getIdentity(pubkey)
  }


// ── Relation operations ───────────────────────────────────────────────────

  /**
   * Create a directed relation between two entities inside a context.
   *
   * @param   {Object}               opts
   * @param   {string}               opts.from
   * @param   {string}               opts.to
   * @param   {string}               opts.type        - Relation type label (e.g. `'reply'`)
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<Edge>}
   * @throws  {Error} If required parameters are missing
   */
  async relate (opts) {
    if (!this.opened) await this.ready()
    if (!opts) throw new Error('Options object is required')
    if (!opts.from) throw new Error('opts.from is required')
    if (!opts.to) throw new Error('opts.to is required')
    if (!opts.context) throw new Error('opts.context is required')
    if (!opts.type && !opts.relationType) throw new Error('opts.type or opts.relationType is required')
    if (opts.value !== undefined && (typeof opts.value !== 'number' || !Number.isFinite(opts.value))) {
      throw new Error('opts.value must be a finite number if provided')
    }

    const deviceKeyPair = this.identity.deviceKeyPair
    const author = b4a.isBuffer(deviceKeyPair.publicKey)
      ? deviceKeyPair.publicKey.toString('hex')
      : String(deviceKeyPair.publicKey)

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'relation/create',
      from: opts.from,
      to: opts.to,
      relationType: opts.type || opts.relationType,
      author,
      timestamp: Date.now(),
      signature: null
    }
    if (typeof opts.value === 'number') event.value = opts.value

    const digest = this.#stableRelationHash(event)
    const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
    event.signature = sig.toString('hex')

    await context.append(event)
    await this.#view.update()
    
    // Emit unified change event
    this.#emitter.emit('change', { 
      type: 'relation-create', 
      from: opts.from,
      to: opts.to,
      relationType: opts.type || opts.relationType,
      value: typeof opts.value === 'number' ? opts.value : undefined,
      context: opts.context,
      author,
      timestamp: Date.now()
    })
    
    return event
  }

	/**
   * Remove a directed relation. Both nodes and the relation type must match.
   *
   * @param   {Object}               opts
   * @param   {string}               opts.from
   * @param   {string}               opts.to
   * @param   {string}               opts.type
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<void>}
   * @throws  {Error} If required parameters are missing or the relation does not exist.
   */
  async unrelate (opts) {
    if (!this.opened) await this.ready()
    if (!opts) throw new Error('Options object is required')
    if (!opts.from) throw new Error('opts.from is required')
    if (!opts.to) throw new Error('opts.to is required')
    if (!opts.context) throw new Error('opts.context is required')
    if (!opts.type && !opts.relationType) throw new Error('opts.type or opts.relationType is required')

    const deviceKeyPair = this.identity.deviceKeyPair
    const author = b4a.isBuffer(deviceKeyPair.publicKey)
      ? deviceKeyPair.publicKey.toString('hex')
      : String(deviceKeyPair.publicKey)

    const context = await this.#getContext(opts.context)

    const edgeRefKey = `er:${opts.from}:${opts.type || opts.relationType}:${opts.to}`
    const edgeRef = await context.get(edgeRefKey)
    if (!edgeRef || !edgeRef.value || !edgeRef.value.ref) throw new Error('Relation not found')

    const edge = await context.get(edgeRef.value.ref)
    if (!edge || !edge.value || edge.value.deleted) throw new Error('Relation not found')

    const event = {
      type: 'relation/delete',
      from: opts.from,
      to: opts.to,
      relationType: opts.type || opts.relationType,
      author,
      createdAt: edge.value.createdAt,
      timestamp: Date.now(),
      signature: null
    }

    const digest = this.#stableRelationHash(event)
    const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
    event.signature = sig.toString('hex')

    await context.append(event)
    await this.#view.update()
  }

  /**
   * Iterate over the edges of an entity.
   *
   * Because indexes are append-only logs the complexity is O(n).
   * For most P2P social patterns (1-hop fan-out reads) this is fine.
   *
   * @param   {string}        entityId
   * @param   {EdgeQueryOpts} [opts]
   * @returns {AsyncGenerator<Edge>}
   *
   * @example
   * for await (const edge of graph.edges('post/abc/0', { direction: 'in', type: 'reply' })) {
   *   console.log(edge.from)
   * }
   */
  edges (entityId, opts = {}) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.#view.getEdges(entityId, opts)
      }).call(this)
    }
    return this.#view.getEdges(entityId, opts)
  }

  /**
   * Count edges of a given type and direction across all open contexts.
   *
   * @param   {string} entityId
   * @param   {string} type      - Relation type label
   * @param   {'in'|'out'} direction - Edge direction
   * @returns {Promise<number>}
   */
  async #countEdges (entityId, type, direction) {
    if (!this.opened) await this.ready()
    const key = `cnt:${direction}:${entityId}:${type}`
    let total = 0

    const seen = new Set()

    for (const [, context] of this.#contexts) {
      if (!context.opened) continue
      const viewKey = context.view && context.view.core && context.view.core.key
        ? context.view.core.key.toString('hex')
        : null
      if (viewKey) {
        if (seen.has(viewKey)) continue
        seen.add(viewKey)
      }
      const result = await context.get(key)
      if (result && result.value && typeof result.value.count === 'number') total += result.value.count
    }

    return total
  }

  /**
   * Count incoming edges of a given type across all open contexts.
   *
   * @param   {string} entityId
   * @param   {string} type      - Relation type label
   * @returns {Promise<number>}
   */
  async countEdgesIn (entityId, type) {
    return this.#countEdges(entityId, type, 'in')
  }

  /**
   * Count outgoing edges of a given type across all open contexts.
   *
   * @param   {string} entityId
   * @param   {string} type      - Relation type label
   * @returns {Promise<number>}
   */
  async countEdgesOut (entityId, type) {
    return this.#countEdges(entityId, type, 'out')
  }


// ── Tag operations ────────────────────────────────────────────────────────

  /**
   * Add a tag to an entity inside a context. Only the entity author can tag.
   *
   * @param   {string}               entityId
   * @param   {string}               tag
   * @param   {Object}               opts
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<void>}
   * @throws  {Error} If required parameters are missing, entity is not found, or the caller is not the author.
   */
  async tag (entityId, tag, opts = {}) {
    if (!this.opened) await this.ready()
    if (!entityId) throw new Error('entityId is required')
    if (!tag) throw new Error('tag is required')
    if (!opts) throw new Error('opts is required')
    if (!opts.context) throw new Error('opts.context is required')

    const deviceKeyPair = this.identity.deviceKeyPair
    const author = b4a.isBuffer(deviceKeyPair.publicKey)
      ? deviceKeyPair.publicKey.toString('hex')
      : String(deviceKeyPair.publicKey)

    const node = await this.#view.getNode(entityId)
    if (!node) throw new Error('Entity not found')
    if (node.author !== author) throw new Error('Only the entity author can tag it')

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'tag/add',
      entityId,
      tag,
      author,
      timestamp: Date.now(),
      signature: null
    }

    const digest = stableTagHash(event)
    const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
    event.signature = sig.toString('hex')

    await context.append(event)
    await this.#view.update()
  }

  /**
   * Remove a tag from an entity inside a context. Only the entity author can untag.
   *
   * @param   {string}               entityId
   * @param   {string}               tag
   * @param   {Object}               opts
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<void>}
   * @throws  {Error} If required parameters are missing, entity is not found, or the caller is not the author.
   */
  async untag (entityId, tag, opts = {}) {
    if (!this.opened) await this.ready()
    if (!entityId) throw new Error('entityId is required')
    if (!tag) throw new Error('tag is required')
    if (!opts) throw new Error('opts is required')
    if (!opts.context) throw new Error('opts.context is required')

    const deviceKeyPair = this.identity.deviceKeyPair
    const author = b4a.isBuffer(deviceKeyPair.publicKey)
      ? deviceKeyPair.publicKey.toString('hex')
      : String(deviceKeyPair.publicKey)

    const node = await this.#view.getNode(entityId)
    if (!node) throw new Error('Entity not found')
    if (node.author !== author) throw new Error('Only the entity author can untag it')

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'tag/remove',
      entityId,
      tag,
      author,
      timestamp: Date.now(),
      signature: null
    }

    const digest = stableTagHash(event)
    const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
    event.signature = sig.toString('hex')

    await context.append(event)
    await this.#view.update()
  }

  /**
   * Iterate over entities that carry a given tag.
   *
   * Supports trust filtering: pass `author` or `authors` to only yield
   * entities tagged by a trusted set.
   *
   * @param   {string}        tag
   * @param   {Object}        [opts]
   * @param   {PubKeyHex}     [opts.author]   - Single-author filter
   * @param   {PubKeyHex[]}   [opts.authors]  - Multi-author filter (OR)
   * @returns {AsyncGenerator<Entity>}
   *
   * @example
   * for await (const node of graph.getByTag('pinned', { authors: trustedKeys })) {
   *   console.log(node.id)
   * }
   */
  getByTag (tag, opts = {}) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.#view.getByTag(tag, opts)
      }).call(this)
    }
    return this.#view.getByTag(tag, opts)
  }

  /**
   * Iterate over entities of a given type, in chronological order.
   *
   * Backed by the same type-specific, time-sorted index `query().type()`
   * uses internally — an efficient, indexed scan, not a full table scan.
   *
   * @param   {string} type
   * @returns {AsyncGenerator<Entity>}
   *
   * @example
   * for await (const node of graph.getByType('post')) {
   *   console.log(node.id)
   * }
   */
  getByType (type) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.#view.getByType(type)
      }).call(this)
    }
    return this.#view.getByType(type)
  }

  /**
   * Iterate over entities created by a given author, in the order they
   * appear in that author's own UserCore.
   *
   * Scans that author's own UserCore directly rather than the shared
   * view — since a UserCore already only contains that person's own
   * entities, no separate author index is needed at all. Yields nothing
   * if that author's core hasn't been opened/replicated locally yet (see
   * `openUserCore()`).
   *
   * @param   {PubKeyHex} author
   * @returns {AsyncGenerator<Entity>}
   *
   * @example
   * for await (const node of graph.getByAuthor(authorPubkeyHex)) {
   *   console.log(node.id)
   * }
   */
  getByAuthor (author) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.#view.getByAuthor(author)
      }).call(this)
    }
    return this.#view.getByAuthor(author)
  }

  // ========================================
  // Sync
  // ========================================

  /**
   * Update all indexes (view, contexts, roleBase).
   *
   * Call this after appending events to ensure indexes are up-to-date.
   * Most operations call this automatically.
   *
   * Emits a 'change' event (`{ type: 'sync' }`) if this call actually
   * processed new data — whether from a local write or data that arrived
   * via replication. This is the signal live queries (see
   * `GraphQuery.live()`) subscribe to; it's intentionally coarse (does
   * this graph have new data at all, not which entity/relation changed).
   *
   * @returns {Promise<void>}
   */
  async update () {
    if (!this.opened) await this.ready()
    if (this.#roleBase) await this.#roleBase.update()
    if (this.#scopeBase) await this.#scopeBase.update()

    for (const [, context] of this.#contexts) {
      if (!context || !context.opened) continue
      await context.update()
    }

    const changed = await this.#view.update()
    if (changed) {
      this.#emitter.emit('change', { type: 'sync', timestamp: Date.now() })
    }
  }


// ── RoleBase ──────────────────────────────────────────────────────────────

  /**
   * Create a fresh RoleBase and attach it to this graph instance.
   * Closes any previously attached RoleBase.
   *
   * @returns {Promise<string>} The new RoleBase key as a hex string.
   */
  async createRoleBase () {
    if (!this.opened) await this.ready()

    if (this.#roleBase) await this.#roleBase.close()

    const roles = new RoleBase(this.#store, null, { identity: this.identity })
    await roles.ready()
    this.#roleBase = roles
    return roles.key.toString('hex')
  }

  /**
   * Open an existing RoleBase by key and attach it to this graph instance.
   *
   * @param   {Buffer|string} keyOrHex
   * @returns {Promise<RoleBase>}
   */
  async openRoleBase (keyOrHex) {
    if (!this.opened) await this.ready()
    if (!keyOrHex) throw new Error('RoleBase key is required')

    const keyHex = Buffer.isBuffer(keyOrHex) ? keyOrHex.toString('hex') : keyOrHex
    if (typeof keyHex !== 'string' || keyHex.length === 0) throw new Error('Invalid RoleBase key')

    if (this.#roleBase) await this.#roleBase.close()

    const roles = new RoleBase(this.#store, Buffer.from(keyHex, 'hex'), { identity: this.identity })
    await roles.ready()
    this.#roleBase = roles
    return roles
  }

// ── ScopeBase ─────────────────────────────────────────────────────────────

  /**
   * Create a fresh ScopeBase and attach it to this graph instance.
   * Closes any previously attached ScopeBase. Permission checks on scope
   * actions (scope.create/scope.grant/scope.revoke) are evaluated against
   * whichever RoleBase is currently attached to this graph, if any.
   *
   * @returns {Promise<string>} The new ScopeBase key as a hex string.
   */
  async createScopeBase () {
    if (!this.opened) await this.ready()

    if (this.#scopeBase) await this.#scopeBase.close()

    const scopes = new ScopeBase(this.#store, null, { identity: this.identity, roleBase: this.#roleBase })
    await scopes.ready()
    this.#scopeBase = scopes
    return scopes.key.toString('hex')
  }

  /**
   * Open an existing ScopeBase by key and attach it to this graph instance.
   *
   * @param   {Buffer|string} keyOrHex
   * @returns {Promise<ScopeBase>}
   */
  async openScopeBase (keyOrHex) {
    if (!this.opened) await this.ready()
    if (!keyOrHex) throw new Error('ScopeBase key is required')

    const keyHex = Buffer.isBuffer(keyOrHex) ? keyOrHex.toString('hex') : keyOrHex
    if (typeof keyHex !== 'string' || keyHex.length === 0) throw new Error('Invalid ScopeBase key')

    if (this.#scopeBase) await this.#scopeBase.close()

    const scopes = new ScopeBase(this.#store, Buffer.from(keyHex, 'hex'), { identity: this.identity, roleBase: this.#roleBase })
    await scopes.ready()
    this.#scopeBase = scopes
    return scopes
  }

  /**
   * Get the role string currently assigned to a member.
   *
   * @param   {PubKeyHex} pubkeyHex
   * @returns {Promise<string|null>}
   */
  async getRole (pubkeyHex) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')
    if (typeof pubkeyHex !== 'string' || pubkeyHex.length === 0) throw new Error('Invalid pubkeyHex')

    const registry = await this.#roleBase.getRegistry()
    if (!registry || !registry.members) return null
    return registry.members[pubkeyHex] || null
  }

  /**
   * Check whether a member has a given permission.
   *
   * @param   {PubKeyHex} pubkeyHex
   * @param   {string}    action
   * @returns {Promise<boolean>}
   */
  async can (pubkeyHex, action) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')

    const registry = await this.#roleBase.getRegistry()
    if (!registry) return false
    return canRole(registry, pubkeyHex, action)
  }

  /**
   * Set the role of a member.
   *
   * @param {PubKeyHex} memberPubkeyHex
   * @param {string}    role
   * @param {Object}    opts
   * @param {KeyPair}   opts.keyPair - KeyPair for signing the event
   */
  async setRole (memberPubkeyHex, role, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')
    if (!opts.keyPair || !opts.keyPair.secretKey || !opts.keyPair.publicKey) {
      throw new Error('opts.keyPair is required')
    }

    const author = b4a.isBuffer(opts.keyPair.publicKey)
      ? opts.keyPair.publicKey.toString('hex')
      : String(opts.keyPair.publicKey)

    await this.#roleBase.append({
      type: 'roles/setRole',
      member: memberPubkeyHex,
      role,
      author,
      keyPair: opts.keyPair,
      timestamp: Date.now()
    })
  }

  /**
   * Remove the role of a member.
   *
   * @param {PubKeyHex} memberPubkeyHex
   * @param {Object}    opts
   * @param {PubKeyHex} opts.author
   */
  async removeRole (memberPubkeyHex, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')

    await this.#roleBase.append({
      type: 'roles/removeMember',
      member: memberPubkeyHex,
      author: opts.author,
      timestamp: Date.now()
    })
  }

  /**
   * Add a new owner to the role registry.
   *
   * Requires '*' privilege. Adds the writer core and assigns the owner role.
   *
   * @param {PubKeyHex} memberPubkeyHex - The new owner's hex public key
   * @param {Object} writerCore - The writer core to add
   * @param {Object} opts - Options object
   * @param {PubKeyHex} opts.author - The author's hex public key (must have '*' privilege)
   * @returns {Promise<void>}
   * @throws {Error} If parameters are missing or authorization fails
   */
  async addOwner (memberPubkeyHex, writerCore, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')
    return this.#roleBase.addOwner(memberPubkeyHex, writerCore, opts)
  }


// ── Moderation ────────────────────────────────────────────────────────────

  #stableModerationHash (event) {
    const payload = {
      version: event.version,
      action: event.action,
      target: event.target,
      reason: event.reason || null,
      context: event.context || null
    }

    const msg = {
      op: 'moderation/action',
      payload,
      author: event.author,
      timestamp: event.timestamp
    }

    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  #stableRelationHash (event) {
    const payload = {
      from: event.from,
      to: event.to,
      relationType: event.relationType,
      value: typeof event.value === 'number' ? event.value : null
    }

    const msg = {
      op: event.type,
      payload,
      author: event.author,
      timestamp: event.timestamp
    }

    // For relation/delete, include createdAt
    if (event.createdAt) {
      msg.createdAt = event.createdAt
    }

    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  /**
   * Publish a signed moderation action into a context.
   *
   * This method only records facts (action + signature). Policy enforcement
   * is the responsibility of the application.
   *
   * Allowed actions: `'content.flag'`, `'content.hide'`, `'content.remove'`,
   * `'content.reveal'`.
   *
   * @param   {ModerateActionOpts} opts
   * @returns {Promise<ModerationEvent>}
   * @throws  {Error} If `keyPair`, `context`, `action`, or `target` are missing,
   *                  or if `action` is not one of the four allowed values.
   */
  async moderateAction (opts = {}) {
    if (!this.opened) await this.ready()
    if (!opts.context) throw new Error('Context key is required')
    if (!opts.action) throw new Error('Moderation action is required')
    if (!opts.target) throw new Error('Moderation target is required')

    const VALID_ACTIONS = new Set(['content.flag', 'content.hide', 'content.remove', 'content.reveal'])
    if (!VALID_ACTIONS.has(opts.action)) {
      throw new Error('Unknown moderation action')
    }

    if (!opts.keyPair || !opts.keyPair.secretKey || !opts.keyPair.publicKey) {
      throw new Error('keyPair is required')
    }

    const author = b4a.isBuffer(opts.keyPair.publicKey)
      ? opts.keyPair.publicKey.toString('hex')
      : String(opts.keyPair.publicKey)

    // Client-side fail-fast check: mirrors the apply layer's own
    // semantics (#isModerationAllowed) rather than duplicating a
    // stricter one. "No RoleBase yet" or "registry not ready yet" means
    // "not yet determined" — allowed through here, exactly as the apply
    // layer queues it as pending rather than rejecting outright (see the
    // "records a signed fact even before a RoleBase exists" test). Only
    // a RoleBase that has a registry AND explicitly denies the action
    // throws here — previously this method had no pre-check at all, so
    // an unauthorized caller got no error at all; the action just
    // silently never took effect once the apply layer rejected it.
    if (this.#roleBase) {
      let registry = null
      try {
        registry = await this.#roleBase.getRegistry()
      } catch {
        registry = null
      }
      if (registry && !canRole(registry, author, opts.action)) {
        throw new Error('Not authorized to perform this moderation action')
      }
    }

    const event = {
      type: 'moderation/action',
      version: 1,
      action: opts.action,
      target: opts.target,
      reason: opts.reason || null,
      // optional redundant context for debugging
      context: opts.includeContext ? (Buffer.isBuffer(opts.context) ? opts.context.toString('hex') : opts.context) : null,
      author,
      timestamp: Date.now(),
      signature: null
    }

    const digest = this.#stableModerationHash(event)
    const sig = hypercoreCrypto.sign(digest, opts.keyPair.secretKey)
    event.signature = sig.toString('hex')

    const ctx = await this.#getContext(opts.context)
    const result = await ctx.append(event)
    await this.#view.update()

    // Generate eventId based on core key and sequence
    const coreKeyHex = ctx.core ? ctx.core.key.toString('hex') : ''
    const seq = typeof result.length === 'number' ? result.length - 1 : -1
    const eventId = crypto.createHash('sha256').update(`${coreKeyHex}:${seq}`).digest('hex')

    return { ...event, eventId }
  }


// ── Query builder ─────────────────────────────────────────────────────────

  /**
   * Return a fluent query builder scoped to the current view.
   *
   * @param   {Object} [opts]
   * @returns {GraphQuery}
   *
   * @example
   * const posts = await graph.query().type('post').toArray()
   */
  query (opts = {}) {
    if (!this.opened) this.ready().then(() => {})
    return new GraphQuery(this.#view, opts, this)
  }


  /**
   * Query events from a context.
   *
   * Currently supports moderation event queries.
   *
   * @param   {Object} opts
   * @param   {'moderation'} opts.type - Query type (only 'moderation' supported)
   * @param   {ContextKeyHex|Buffer} opts.context - Context key
   * @param   {string} opts.target - Target entity ID
   * @param   {PubKeyHex[]} [opts.authors] - Allowlist of authors
   * @param   {PubKeyHex} [opts.author] - Single-author shorthand
   * @param   {number} [opts.since] - Unix ms lower bound (inclusive)
   * @returns {AsyncGenerator<Object>} Async iterator of moderation events
   * @throws  {Error} If query type is not supported or required parameters are missing
   */
  queryContext (opts = {}) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.queryContext(opts)
      }).call(this)
    }

    if (!opts || opts.type !== 'moderation') throw new Error('Unsupported context query type')
    if (!opts.context) throw new Error('Context key is required')
    if (!opts.target) throw new Error('Moderation target is required')

    const authors = opts.authors || (opts.author ? [opts.author] : null)
    const allow = authors ? new Set(authors) : null
    const since = typeof opts.since === 'number' ? opts.since : null

    return (async function * () {
      const ctx = await this.#getContext(opts.context)

      // by-target index: m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq>
      const prefix = `m:t:${opts.target}:`
      const gte = since != null ? `${prefix}${toSortableTs(since)}:` : prefix

      const stream = ctx.view.createReadStream({
        gte,
        lt: prefix + '\uffff'
      })

      for await (const entry of stream) {
        const v = entry.value
        if (allow && !allow.has(v.author)) continue
        yield v
      }
    }).call(this)
  }


  // ── Context management ────────────────────────────────────────────────────

  /**
   * @typedef {Object} CreateContextOpts
   * @property {'open'|'closed'} [writeMode='open']
   *   `'open'`   — any core can be added as a writer freely.
   *   `'closed'` — writers must be explicitly authorised; requires an attached RoleBase.
   * @property {Object} [keyPair]
   *   Optional keyPair for the local writer. In closed mode, this is typically required.
   */

  async #getContext (keyOrHex, opts = {}) {
    if (!keyOrHex) throw new Error('Context key is required')

    const keyHex = Buffer.isBuffer(keyOrHex) ? keyOrHex.toString('hex') : keyOrHex
    if (typeof keyHex !== 'string' || keyHex.length === 0) throw new Error('Invalid context key')

    if (this.#contexts.has(keyHex)) return this.#contexts.get(keyHex)

    const bootstrapKey = Buffer.from(keyHex, 'hex')
    
    // In open mode, provide the user's keyPair to ensure the local writer is set up
    // This allows peers to append when joining an existing context
    const contextOpts = {
      keyEncoding: this.#keyEncoding,
      valueEncoding: this.#valueEncoding,
      writeMode: opts.writeMode,
      roleBase: {
        getRegistry: () => (this.#roleBase ? this.#roleBase.getRegistry() : null),
        can: (pubkeyHex, action) => (this.#roleBase ? this.can(pubkeyHex, action) : false)
      }
    }

    // Pass through keyPair if explicitly provided (required for closed mode)
    if (opts.keyPair) {
      contextOpts.keyPair = opts.keyPair
    } else if (opts.writeMode === 'open' && bootstrapKey) {
      // In open mode without explicit keyPair, use the user's keyPair
      contextOpts.keyPair = this.identity.deviceKeyPair
    }
    
    const context = new ContextBase(this.#store, bootstrapKey, contextOpts)
    await context.ready()
    this.#contexts.set(keyHex, context)

    // Register context with view
    this.#view.addContext(keyHex, context)

    // Forward context events to unified change event
    context.on('writer-added', (writerKey) => {
      this.#emitter.emit('change', { 
        type: 'writer-added', 
        contextKey: keyHex,
        writerKey: Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey,
        timestamp: Date.now()
      })
    })
    context.on('writer-request', (writerKey) => {
      this.#emitter.emit('change', { 
        type: 'writer-request', 
        contextKey: keyHex,
        writerKey: Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey,
        timestamp: Date.now()
      })
    })
    context.on('writer-approved', (writerKey) => {
      this.#emitter.emit('change', { 
        type: 'writer-approved', 
        contextKey: keyHex,
        writerKey: Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey,
        timestamp: Date.now()
      })
    })
    context.on('writer-rejected', (writerKey) => {
      this.#emitter.emit('change', { 
        type: 'writer-rejected', 
        contextKey: keyHex,
        writerKey: Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey,
        timestamp: Date.now()
      })
    })

    return context
  }

  /**
   * Create a new Autobase context and return its key as a hex string.
   *
   * @param   {CreateContextOpts} [opts]
   * @returns {Promise<ContextKeyHex>}
   */
  async createContext (opts = {}) {
    if (!this.opened) await this.ready()

    const context = new ContextBase(this.#store, null, {
      keyEncoding: this.#keyEncoding,
      valueEncoding: this.#valueEncoding,
      writeMode: opts.writeMode,
      roleBase: {
        getRegistry: () => (this.#roleBase ? this.#roleBase.getRegistry() : null),
        can: (pubkeyHex, action) => (this.#roleBase ? this.can(pubkeyHex, action) : false)
      }
    })
    await context.ready()

    const keyHex = context.key.toString('hex')
    this.#contexts.set(keyHex, context)
    this.#view.addContext(keyHex, context)

    return keyHex
  }

  /**
   * Open (or return the cached) context for a given key.
   *
   * @param   {ContextKeyHex|Buffer} keyOrHex
   * @param   {CreateContextOpts}    [opts]
   * @returns {Promise<ContextBase>}
   */
  async openContext (keyOrHex, opts = {}) {
    if (!this.opened) await this.ready()
    const ctx = await this.#getContext(keyOrHex, opts)
    return ctx
  }

  // ========================================
  // Remote cores (indexing)
  // ========================================

  /**
   * Open a remote user core for indexing.
   *
   * If the core is already open, returns the cached instance.
   *
   * @param   {Buffer|string} keyOrHex - The core key or hex string
   * @returns {Promise<UserCore>}
   * @throws  {Error} If keyOrHex is invalid
   */
  async openUserCore (keyOrHex) {
    if (!this.opened) await this.ready()

    const keyHex = Buffer.isBuffer(keyOrHex) ? keyOrHex.toString('hex') : keyOrHex
    if (typeof keyHex !== 'string' || keyHex.length === 0) throw new Error('Invalid user core key')
    if (this.#userCores.has(keyHex)) return this.#userCores.get(keyHex)

    const core = new UserCore(this.#store, {
      key: Buffer.from(keyHex, 'hex'),
      keyEncoding: this.#keyEncoding,
      valueEncoding: this.#valueEncoding
    })
    await core.ready()
    this.#userCores.set(keyHex, core)
    this.#view.addUserCore(keyHex, core)
    return core
  }

  // ========================================
  // Replication Helpers (app uses these)
  // ========================================

  /**
   * Handle a peer connection for automatic writer authorization.
   * This should be called when a peer connects via Hyperswarm.
   * Follows the forum-web pattern for peer discovery using relation edges.
   * 
   * @param {Buffer} peerKey - The peer's public key
   * @param {Buffer|string|undefined} [contextKey] - Optional context key for context-specific writer authorization
   * @param {Object} [opts] - Additional options
   * @returns {Promise<void>}
   */
  async handlePeerConnection (peerKey, contextKey, opts = {}) {
    // Peer discovery is now handled by HypergraphNetwork
    // This method is kept for backward compatibility

    // Handle writer authorization for the specified context
    if (contextKey) {
      try {
        const context = await this.openContext(contextKey)
        await context.handlePeerConnection(peerKey, opts)
        
        // Announce local core using graph.relate() (forum-web pattern)
        if (context.base && context.base.local) {
          try {
            const author = this.identity.deviceKeyPair.publicKey.toString('hex')
            await this.relate({
              from: `localcore:${context.base.local.key.toString('hex')}`,
              to: `context:${contextKey}`,
              type: 'local-core-announce',
              author,
              context: contextKey
            })
          } catch (err) {
            safetyCatch(err)
          }
        }
        
        // Discover remote local cores using graph.edges() (forum-web pattern)
        await this.discoverRemoteLocalCores(contextKey)
      } catch (err) {
        // Context might not exist yet
        safetyCatch(err)
      }
    }
  }

  /**
   * Discover and open remote local cores from relation announcements.
   * This follows the forum-web pattern for peer discovery.
   * 
   * @param {Buffer|string} contextKey - The context key
   * @returns {Promise<void>}
   */
  async discoverRemoteLocalCores (contextKey) {
    try {
      await this.update()
      const contextKeyStr = Buffer.isBuffer(contextKey) ? contextKey.toString('hex') : contextKey
      
      for await (const e of this.edges(`context:${contextKeyStr}`, { direction: 'in', type: 'local-core-announce' })) {
        const from = e && e.from ? String(e.from) : ''
        if (!from.startsWith('localcore:')) continue
        const localKeyHex = from.slice('localcore:'.length)
        if (!localKeyHex) continue
        
        // Don't try to open our own local core
        const context = await this.openContext(contextKey)
        if (context.base && context.base.local && localKeyHex === context.base.local.key.toString('hex')) continue
        
        // Try to open the remote local core
        try {
          const core = this.#store.get({ key: Buffer.from(localKeyHex, 'hex') })
          await core.ready()
          // The core is now in the store and will be replicated
        } catch (err) {
          // Core might not be available yet
          safetyCatch(err)
        }
      }
    } catch (err) {
      safetyCatch(err)
    }
  }

  /**
   * Register an event listener.
   *
   * Hypergraph currently only emits `'change'`. Peer discovery events
   * (`'peer-join'`, `'peer-leave'`) are emitted by `HypergraphNetwork`, not
   * by Hypergraph itself — subscribe on your `HypergraphNetwork` instance
   * for those.
   *
   * @param   {string}   event - Event name (only `'change'` is supported)
   * @param   {Function} callback
   * @returns {this}
   * @throws  {Error} If `event` is not `'change'`
   */
  on (event, callback) {
    if (event !== 'change') {
      throw new Error(`Unsupported event '${event}'. Hypergraph only emits 'change'; peer discovery events are emitted by HypergraphNetwork.`)
    }
    this.#emitter.on('change', callback)
    return this
  }

  /**
   * Remove an event listener.
   *
   * @param   {string}   event - Event name (only `'change'` is supported)
   * @param   {Function} callback
   * @returns {this}
   * @throws  {Error} If `event` is not `'change'`
   */
  off (event, callback) {
    if (event !== 'change') {
      throw new Error(`Unsupported event '${event}'. Hypergraph only emits 'change'; peer discovery events are emitted by HypergraphNetwork.`)
    }
    this.#emitter.off('change', callback)
    return this
  }

  /**
   * Export the graph state as a bootstrap object.
   * This can be shared with other peers to join the graph.
   * 
   * @param {Object} [opts] - Export options
   * @param {boolean} [opts.includeNetworking=false] - Include networking configuration
   * @param {Buffer|string} [opts.topic] - Hyperswarm topic to include (if includeNetworking is true)
   * @returns {Promise<{version: number, userCoreKey: string, contexts: Array<{key: string, writeMode: 'open' | 'closed'}>, timestamp: number, networking?: {topic: string}>} Bootstrap object
   */
  async export (opts = {}) {
    if (!this.opened) await this.ready()

    const userCoreKey = this.key ? this.key.toString('hex') : ''
    const bootstrap = {
      version: 1,
      userCoreKey,
      contexts: [],
      timestamp: Date.now()
    }

    // Export all contexts
    for (const [key, context] of this.#contexts) {
      bootstrap.contexts.push({
        key,
        writeMode: context.writeMode
      })
    }

    // Include networking info if requested
    if (opts.includeNetworking && opts.topic) {
      const topic = typeof opts.topic === 'string' ? opts.topic : opts.topic.toString('hex')
      bootstrap.networking = {
        topic
      }
    }

    return bootstrap
  }

  /**
   * Join a graph using a bootstrap object.
   * This is a static method that creates a new Hypergraph instance.
   * 
   * @param {Object} store - Corestore instance
   * @param {{version: number, userCoreKey: string, contexts: Array<{key: string, writeMode: 'open' | 'closed'}>, timestamp: number}} bootstrap - Bootstrap object from graph.export()
   * @param {Object} [opts] - Additional options
   * @returns {Promise<Hypergraph>}
   */
  static async join (store, bootstrap, opts = {}) {
    const graph = new Hypergraph(store, opts)
    await graph.ready()

    // Open all contexts from the bootstrap
    for (const ctx of bootstrap.contexts || []) {
      try {
        await graph.openContext(ctx.key, { writeMode: ctx.writeMode })
      } catch (err) {
        // Context might not exist yet
        safetyCatch(err)
      }
    }

    return graph
  }

  /**
   * Create a replication stream for the underlying corestore.
   *
   * @param   {boolean} isInitiator - Whether this side initiated the connection
   * @param   {Object}  opts       - Replication options passed to corestore.replicate
   * @returns {Object} The replication stream
   */
  replicate (isInitiator, opts) {
    return this.#store.replicate(isInitiator, opts)
  }

  /**
   * Connect to a Hyperswarm topic for P2P networking.
   * This is a convenience method that uses HypergraphNetwork internally.
   *
   * @param {Buffer|string} topic - Hyperswarm topic (Buffer or hex string)
   * @param {Object} [opts] - Connection options
   * @param {Object} [opts.swarm] - Hyperswarm instance (optional, will create if not provided)
   * @param {string} [opts.role='peer'] - Role: 'owner' or 'peer'
   * @param {Object<string, string|Buffer>} [opts.contexts] - Context keys for writer authorization (key-value pairs)
   * @param {number} [opts.maxPeers=16] - Maximum peers per swarm
   * @returns {Promise<Object>} The HypergraphNetwork instance
   */
  async connectToSwarm (topic, opts = {}) {
    const HypergraphNetwork = require('./networking')
    const Hyperswarm = require('hyperswarm')
    const swarm = opts.swarm || new Hyperswarm()
    const networking = new HypergraphNetwork(this, this.#store, swarm, {
      topic,
      role: opts.role || 'peer',
      contexts: opts.contexts || {},
      maxPeers: opts.maxPeers || 16
    })
    await networking.connect()
    return networking
  }

  /**
   * Disconnect from a Hyperswarm topic.
   *
   * @param {Object} networking - The HypergraphNetwork instance from connectToSwarm
   * @returns {Promise<void>}
   */
  async disconnectFromSwarm (networking) {
    await networking.disconnect()
  }

  // ========================================
  // Writer Authorization
  // ========================================

  /**
   * Get writer keys for all contexts.
   *
   * @returns {Object} Object mapping context keys to arrays of writer keys
   */
  getAllWriterKeys () {
    const results = {}
    for (const [contextKey, context] of this.#contexts) {
      if (!context.opened) continue
      results[contextKey] = context.writerKeys()
    }
    return results
  }

  /**
   * Get all cores for replication.
   *
   * Returns the user core, view core, and all context cores.
   *
   * @returns {Array<Object>} Array of Hypercore instances
   */
  getCores () {
    const cores = [this.core, this.viewCore]
    for (const context of this.#contexts.values()) {
      cores.push(context.core)
    }
    return cores
  }
}
