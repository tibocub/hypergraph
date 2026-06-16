const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const codecs = require('codecs')
const Hyperbee = require('hyperbee')
const crypto = require('crypto')
const hypercoreCrypto = require('hypercore-crypto')
const b4a = require('b4a')
const UserCore = require('./user-core')
const ContextBase = require('./context-base')
const RoleBase = require('./role-base')
const GraphView = require('./view')
const GraphQuery = require('./query')
const { encodeEvent, decodeEvent } = require('./encodings/event')
const { can: canRole } = require('./roles-registry')
const Hypercore = require('hypercore')

/**
 * Convert a timestamp to a sortable string by padding with zeros.
 *
 * @param   {number} ts - Unix timestamp in milliseconds
 * @returns {string} Zero-padded 16-character string for sorting
 */
const toSortableTs = ts => String(ts).padStart(16, '0')


/**
 * Minimal graph database optimised for P2P social apps on the Holepunch stack.
 *
 * Hypergraph is a thin composition over Hypercore, Corestore, Autobase and
 * Hyperbee. It exposes a local graph API; networking is the responsibility of
 * the application (typically via Hyperswarm).
 *
 * @extends ReadyResource
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

  /**
   * @param {import('corestore')} store
   * @param {HypergraphOpts}      [opts]
   */
  constructor (store, opts = {}) {
    super()

    this.#store = store
    this.#keyEncoding = opts.keyEncoding ? codecs(opts.keyEncoding) : null
    this.#valueEncoding = opts.valueEncoding ? codecs(opts.valueEncoding) : null
    this.#userCoreKey = opts.userCoreKey || null
    this.#userCore = null
    this.#userCores = new Map()
    this.#contexts = new Map()
    this.#view = null
    this.#roleBase = null

    this.ready().catch(safetyCatch)
  }

  async _open () {
    // Get or create the user's personal core
    this.#userCore = new UserCore(this.#store, {
      key: this.#userCoreKey,
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
  }

  async _close () {
    if (this.#view) await this.#view.close()
    if (this.#userCore) await this.#userCore.close()

    if (this.#roleBase) await this.#roleBase.close()

    for (const context of this.#contexts.values()) {
      await context.close()
    }
  }


// ── Getters ──────────────────────────────────────────────────────────────

  /** @returns {import('hypercore')|undefined} The raw user Hypercore (used for replication). */
  get core () {
    return this.#userCore?.core
  }

  /** @returns {GraphView|null} */
  get view () {
    return this.#view
  }

	/** @returns {import('hypercore')|undefined} The raw view Hypercore. */
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
    if (entity.author && entity.author !== author) throw new Error('Entity author must match user core key')

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
  async putContent (entityId, content, contentType = 'text') {
    if (!this.opened) await this.ready()

    if (!entityId) throw new Error('entityId is required')

    const event = {
      type: 'content/append',
      entityId,
      contentType,
      body: content,
      timestamp: Date.now()
    }

    await this.#userCore.append(event)
    await this.#view.update()
    return { entityId, contentType, body: content }
  }

  /**
   * Read the latest content version from an entity.
   *
   * @param   {string} entityId
   * @returns {Promise<{ contentType: string, body: string }|null>}
   */
  async getContent (entityId) {
    if (!this.opened) await this.ready()
    return this.#view.getContent(entityId)
  }


// ── Identity operations ───────────────────────────────────────────────────

  /**
   * Set the identity profile for the local user.
   *
   * @param   {Object} profile
   * @param   {string} [profile.username] - The username to set
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
   * @param   {PubKeyHex}            opts.author
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<Edge>}
   */
  async relate (opts) {
    if (!this.opened) await this.ready()

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'relation/create',
      from: opts.from,
      to: opts.to,
      relationType: opts.type || opts.relationType,
      author: opts.author,
      timestamp: Date.now()
    }

    await context.append(event)
    await this.#view.update()
    return event
  }

	/**
   * Remove a directed relation. Both nodes and the relation type must match.
   *
   * @param   {Object}               opts
   * @param   {string}               opts.from
   * @param   {string}               opts.to
   * @param   {string}               opts.type
   * @param   {PubKeyHex}            opts.author
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<void>}
   * @throws  {Error} If the relation does not exist.
   */
  async unrelate (opts) {
    if (!this.opened) await this.ready()

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
      author: opts.author,
      createdAt: edge.value.createdAt,
      timestamp: Date.now()
    }

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
   * Count incoming edges of a given type across all open contexts.
   *
   * @param   {string} entityId
   * @param   {string} type      - Relation type label
   * @returns {Promise<number>}
   */
  async countEdgesIn (entityId, type) {
    if (!this.opened) await this.ready()
    const key = `cnt:in:${entityId}:${type}`
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
   * Count outgoing edges of a given type across all open contexts.
   *
   * @param   {string} entityId
   * @param   {string} type      - Relation type label
   * @returns {Promise<number>}
   */
  async countEdgesOut (entityId, type) {
    if (!this.opened) await this.ready()
    const key = `cnt:out:${entityId}:${type}`
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


// ── Tag operations ────────────────────────────────────────────────────────

  /**
   * Add a tag to an entity inside a context. Only the entity author can tag.
   *
   * @param   {string}               entityId
   * @param   {string}               tag
   * @param   {Object}               opts
   * @param   {PubKeyHex}            opts.author
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<Object>} The appended tag event
   * @throws  {Error} If the entity is not found or the caller is not the author.
   */
  async tag (entityId, tag, opts = {}) {
    if (!this.opened) await this.ready()

    const node = await this.#view.getNode(entityId)
    if (!node) throw new Error('Entity not found')
    if (node.author !== opts.author) throw new Error('Only the entity author can tag it')

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'tag/add',
      entityId,
      tag,
      author: opts.author,
      timestamp: Date.now()
    }

    await context.append(event)
    await this.#view.update()
    return event
  }

  /**
   * Remove a tag from an entity inside a context. Only the entity author can untag.
   *
   * @param   {string}               entityId
   * @param   {string}               tag
   * @param   {Object}               opts
   * @param   {PubKeyHex}            opts.author
   * @param   {ContextKeyHex|Buffer} opts.context
   * @returns {Promise<Object>} The appended tag event
   * @throws  {Error} If the entity is not found or the caller is not the author.
   */
  async untag (entityId, tag, opts = {}) {
    if (!this.opened) await this.ready()

    const node = await this.#view.getNode(entityId)
    if (!node) throw new Error('Entity not found')
    if (node.author !== opts.author) throw new Error('Only the entity author can untag it')

    const context = await this.#getContext(opts.context)

    const event = {
      type: 'tag/remove',
      entityId,
      tag,
      author: opts.author,
      timestamp: Date.now()
    }

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

  // ========================================
  // Sync
  // ========================================

  async update () {
    if (!this.opened) await this.ready()
    if (this.#roleBase) await this.#roleBase.update()

    for (const [, context] of this.#contexts) {
      if (!context || !context.opened) continue
      await context.update()
    }

    await this.#view.update()
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

    const roles = new RoleBase(this.#store, null)
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

    const roles = new RoleBase(this.#store, Buffer.from(keyHex, 'hex'))
    await roles.ready()
    this.#roleBase = roles
    return roles
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

    const entry = await this.#roleBase.view.get(`roles:member:${pubkeyHex}`)
    return entry && entry.value ? entry.value.role : null
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
   * @param {PubKeyHex} opts.author
   */
  async setRole (memberPubkeyHex, role, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')

    await this.#roleBase.append({
      type: 'roles/setRole',
      member: memberPubkeyHex,
      role,
      author: opts.author,
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
   * @param {import('hypercore')} writerCore - The writer core to add
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

    if (opts.action !== 'content.flag' && opts.action !== 'content.hide' && opts.action !== 'content.remove' && opts.action !== 'content.reveal') {
      throw new Error('Unknown moderation action')
    }

    if (!opts.keyPair || !opts.keyPair.secretKey || !opts.keyPair.publicKey) {
      throw new Error('keyPair is required')
    }

    const author = b4a.isBuffer(opts.keyPair.publicKey)
      ? opts.keyPair.publicKey.toString('hex')
      : String(opts.keyPair.publicKey)

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
    await ctx.append(event)
    await this.#view.update()
    return event
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
    return new GraphQuery(this.#view, opts)
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
   */

  async #getContext (keyOrHex, opts = {}) {
    if (!keyOrHex) throw new Error('Context key is required')

    const keyHex = Buffer.isBuffer(keyOrHex) ? keyOrHex.toString('hex') : keyOrHex
    if (typeof keyHex !== 'string' || keyHex.length === 0) throw new Error('Invalid context key')

    if (this.#contexts.has(keyHex)) return this.#contexts.get(keyHex)

    const bootstrapKey = Buffer.from(keyHex, 'hex')
    const context = new ContextBase(this.#store, bootstrapKey, {
      keyEncoding: this.#keyEncoding,
      valueEncoding: this.#valueEncoding,
      writeMode: opts.writeMode,
      roleBase: {
        getRegistry: () => (this.#roleBase ? this.#roleBase.getRegistry() : null),
        can: (pubkeyHex, action) => (this.#roleBase ? this.can(pubkeyHex, action) : false)
      }
    })
    await context.ready()
    this.#contexts.set(keyHex, context)

    // Register context with view
    this.#view.addContext(keyHex, context)

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

  replicate (isInitiator, opts) {
    return this.#store.replicate(isInitiator, opts)
  }

  // Get all cores for replication
  getCores () {
    const cores = [this.core, this.viewCore]
    for (const context of this.#contexts.values()) {
      cores.push(context.core)
    }
    return cores
  }
}
