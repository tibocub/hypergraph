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

/**
* @param ts {string}
*/
const toSortableTs = ts => String(ts).padStart(16, '0')

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

  // Core access for replication (app handles this)
  get core () {
    return this.#userCore?.core
  }

  get view () {
    return this.#view
  }

  get viewCore () {
    return this.#view?.bee?.core
  }

  get key () {
    return this.#userCore?.core?.key
  }

  get discoveryKey () {
    return this.#userCore?.core?.discoveryKey
  }

  get roleBase () {
    return this.#roleBase
  }

  userCoreKeys () {
    return Array.from(this.#userCores.keys()).sort()
  }

  // ========================================
  // Entity Operations
  // ========================================

  async put (entity) {
    if (!this.opened) await this.ready()
    if (!this.#userCore.writable) throw new Error('User core is read-only')

    const author = this.#userCore.key.toString('hex')
    if (entity.author && entity.author !== author) throw new Error('Entity author must match user core key')

    // Deterministic IDs are assigned after append.
    // Callers must not provide IDs.
    if (entity.id) throw new Error('Entity id must not be provided')

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

  async get (id) {
    if (!this.opened) await this.ready()
    return this.#view.getNode(id)
  }

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

  // ========================================
  // Content Operations
  // ========================================

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

  // ========================================
  // Identity (canonical, user-core)
  // ========================================

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

  async getIdentity (pubkey) {
    if (!this.opened) await this.ready()
    return this.#view.getIdentity(pubkey)
  }

  async getContent (entityId) {
    if (!this.opened) await this.ready()
    return this.#view.getContent(entityId)
  }

  // ========================================
  // Relation Operations
  // ========================================

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

  edges (entityId, opts = {}) {
    if (!this.opened) {
      return (async function * () {
        await this.ready()
        yield * this.#view.getEdges(entityId, opts)
      }).call(this)
    }
    return this.#view.getEdges(entityId, opts)
  }

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

  // ========================================
  // Tag Operations
  // ========================================

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

  // ========================================
  // RoleBase / Roles
  // ========================================

  async createRoleBase () {
    if (!this.opened) await this.ready()

    if (this.#roleBase) await this.#roleBase.close()

    const roles = new RoleBase(this.#store, null)
    await roles.ready()
    this.#roleBase = roles
    return roles.key.toString('hex')
  }

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

  async getRole (pubkeyHex) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')
    if (typeof pubkeyHex !== 'string' || pubkeyHex.length === 0) throw new Error('Invalid pubkeyHex')

    const entry = await this.#roleBase.view.get(`roles:member:${pubkeyHex}`)
    return entry && entry.value ? entry.value.role : null
  }

  async can (pubkeyHex, action) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')

    const registry = await this.#roleBase.getRegistry()
    if (!registry) return false
    return canRole(registry, pubkeyHex, action)
  }

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

  async addOwner (memberPubkeyHex, writerCore, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#roleBase) throw new Error('RoleBase is not open')
    return this.#roleBase.addOwner(memberPubkeyHex, writerCore, opts)
  }

  // ========================================
  // Query Interface
  // ========================================

  query (opts = {}) {
    if (!this.opened) this.ready().then(() => {})
    return new GraphQuery(this.#view, opts)
  }

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

  // ========================================
  // Moderation (facts only, policy in app)
  // ========================================

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

  // ========================================
  // Context Management
  // ========================================

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
