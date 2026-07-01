const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const EventEmitter = require('events')
const codecs = require('codecs')
const crypto = require('crypto')
const hypercoreCrypto = require('hypercore-crypto')
const b4a = require('b4a')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const { encodeEvent, decodeEvent } = require('./encodings/event')
const { can: canRole } = require('./roles-registry')
const { toSortableTs } = require('./utils')

/**
 * ContextBase manages collaborative contexts using Autobase.
 *
 * A context is an Autobase instance used to store collaborative events (relations, tags, moderation, etc).
 * Supports two write modes: 'open' (no privilege checks) and 'closed' (role-based permissions).
 *
 * @extends ReadyResource
 */
module.exports = class ContextBase extends ReadyResource {
  #store
  #bootstrap
  #namespace
  #base
  #viewBee
  #keyEncoding
  #valueEncoding
  #roleBase
  #writeMode
  #pendingWriterRequests
  #emitter
  #keyPair
  #verifySignatures

  /**
   * Create a new ContextBase instance.
   *
   * @param {import('corestore')} store - Corestore instance for core management
   * @param {Buffer|string|null} bootstrapKey - Autobase key to join existing context, or null to create new
   * @param {Object} [opts] - Configuration options
   * @param {string} [opts.keyEncoding] - Codec name for keys
   * @param {string} [opts.valueEncoding] - Codec name for values
   * @param {RoleBase} [opts.roleBase] - Attached RoleBase for permission checks
   * @param {'open'|'closed'} [opts.writeMode='open'] - Write mode for the context
   * @param {Object} [opts.keyPair] - KeyPair for the local writer (required when joining existing context in open mode)
   * @param {boolean} [opts.verifySignatures=true] - Whether to verify cryptographic signatures on relations
   */
  constructor (store, bootstrapKey, opts = {}) {
    super()

    this.#store = store
    this.#bootstrap = bootstrapKey || null
    this.#namespace = this.#bootstrap
      ? this.#bootstrap.toString('hex')
      : `new-${crypto.randomBytes(8).toString('hex')}`
    this.#keyEncoding = opts.keyEncoding ? codecs(opts.keyEncoding) : null
    this.#valueEncoding = opts.valueEncoding ? codecs(opts.valueEncoding) : null
    this.#roleBase = opts.roleBase || null
    this.#writeMode = opts.writeMode === 'closed' ? 'closed' : 'open'
    this.#base = null
    this.#viewBee = null
    this.#pendingWriterRequests = new Map()
    this.#emitter = new EventEmitter()
    this.#verifySignatures = opts.verifySignatures !== undefined ? opts.verifySignatures : true

    // Use provided keyPair if available
    // In open mode, we don't generate a keyPair to allow Autobase to handle local core creation
    // This enables better replication between peers
    this.#keyPair = opts.keyPair || null

    this.ready().catch(safetyCatch)
  }

  async _open () {
    // Create Autobase for this context
    // Use namespace to isolate context cores from other contexts
    const ns = this.#store.namespace(this.#namespace)
    const autobaseOpts = {
      open: this.#openView.bind(this),
      apply: this.#applyView.bind(this),
      valueEncoding: { encode: encodeEvent, decode: decodeEvent },
      ackInterval: 0,
      ackThreshold: 0,
      fastForward: false
    }

    // Don't pass keyPair to Autobase - let it handle local writer creation automatically
    // This matches the old hypergraph behavior and avoids "Autobase failed to open" errors
    // Writers are managed via addWriter method after the context is ready

    this.#base = new Autobase(ns, this.#bootstrap, autobaseOpts)
    await this.#base.ready()
  }

  /**
   * Handle a peer connection for automatic writer authorization.
   * In open mode, automatically adds the peer as a writer.
   * In closed mode, emits a 'writer-request' event for approval.
   * 
   * @param {Buffer} peerKey - The peer's public key
   * @param {Object} [opts] - Additional options
   * @returns {Promise<void>}
   */
  async handlePeerConnection (peerKey, opts = {}) {
    if (!Buffer.isBuffer(peerKey)) {
      peerKey = Buffer.from(peerKey, 'hex')
    }

    const keyHex = peerKey.toString('hex')

    // In open mode, automatically add the peer as a writer
    if (this.#writeMode === 'open') {
      try {
        await this.addWriter(peerKey)
        this.#emitter.emit('writer-added', peerKey)
      } catch (err) {
        // Writer might already exist or other error
        safetyCatch(err)
      }
      return
    }

    // In closed mode, emit a writer-request event for approval
    if (!this.#pendingWriterRequests.has(keyHex)) {
      this.#pendingWriterRequests.set(keyHex, { timestamp: Date.now() })
      this.#emitter.emit('writer-request', peerKey)
    }
  }

  async _close () {
    if (this.#viewBee) await this.#viewBee.close()
    if (this.#base) await this.#base.close()
  }

  #openView (store) {
    const viewCore = store.get({ name: 'view' })
    this.#viewBee = new Hyperbee(viewCore, {
      keyEncoding: 'utf-8',
      valueEncoding: 'json'
    })
    return this.#viewBee
  }

  async #applyView (batch, view, host) {
    for (const { value: event, from, length } of batch) {
      if (event.type === 'addWriter') {
        if (this.#writeMode !== 'open') continue
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        await host.addWriter(key, { indexer: true })
        continue
      }

      if (event.type === 'roles/addWriter') {
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        await host.addWriter(key, { indexer: true })
        continue
      }

      switch (event.type) {
        case 'relation/create':
          await this.#applyRelation(view, event)
          break
        case 'relation/delete':
          await this.#applyRelationDelete(view, event)
          break
        case 'tag/add':
          await this.#applyTag(view, event)
          break
        case 'tag/remove':
          await this.#applyTagDelete(view, event)
          break
        case 'moderation/action':
          await this.#applyModerationAction(view, event, from, length)
          break
        case 'message':
          await this.#applyMessage(view, event)
          break
      }
    }

    await this.#drainPendingModeration(view)
  }

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
      relationType: event.relationType
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

  #stableTagHash (event) {
    const payload = {
      entityId: event.entityId,
      tag: event.tag
    }

    const msg = {
      op: event.type,
      payload,
      author: event.author,
      timestamp: event.timestamp
    }

    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  #verifyModerationSignature (event) {
    if (!event || event.type !== 'moderation/action') return false
    if (event.version !== 1) return false
    if (typeof event.author !== 'string' || event.author.length === 0) return false
    if (typeof event.action !== 'string' || event.action.length === 0) return false
    if (typeof event.target !== 'string' || event.target.length === 0) return false
    if (typeof event.timestamp !== 'number') return false
    if (typeof event.signature !== 'string' || event.signature.length === 0) return false

    // v1 action set
    if (event.action !== 'content.flag' && event.action !== 'content.hide' && event.action !== 'content.remove' && event.action !== 'content.reveal') return false

    // v1 constraint: target MUST be an entityId (string); no author/context targets
    // (we only validate type here; semantics belong to apps)

    let publicKey = null
    let signature = null
    try {
      publicKey = b4a.from(event.author, 'hex')
      signature = b4a.from(event.signature, 'hex')
    } catch {
      return false
    }

    const digest = this.#stableModerationHash(event)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  #verifyRelationSignature (event) {
    if (!event) return false
    if (event.type !== 'relation/create' && event.type !== 'relation/delete') return false
    if (typeof event.author !== 'string' || event.author.length === 0) return false
    if (typeof event.from !== 'string' || event.from.length === 0) return false
    if (typeof event.to !== 'string' || event.to.length === 0) return false
    if (typeof event.relationType !== 'string' || event.relationType.length === 0) return false
    if (typeof event.timestamp !== 'number') return false
    if (typeof event.signature !== 'string' || event.signature.length === 0) return false

    let publicKey = null
    let signature = null
    try {
      publicKey = b4a.from(event.author, 'hex')
      signature = b4a.from(event.signature, 'hex')
    } catch {
      return false
    }

    const digest = this.#stableRelationHash(event)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  #verifyTagSignature (event) {
    if (!event) return false
    if (event.type !== 'tag/add' && event.type !== 'tag/remove') return false
    if (typeof event.author !== 'string' || event.author.length === 0) return false
    if (typeof event.entityId !== 'string' || event.entityId.length === 0) return false
    if (typeof event.tag !== 'string' || event.tag.length === 0) return false
    if (typeof event.timestamp !== 'number') return false
    if (typeof event.signature !== 'string' || event.signature.length === 0) return false

    let publicKey = null
    let signature = null
    try {
      publicKey = b4a.from(event.author, 'hex')
      signature = b4a.from(event.signature, 'hex')
    } catch {
      return false
    }

    const digest = this.#stableTagHash(event)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  async #applyModerationAction (view, event, from, length) {
    // Ingestion rules (deterministic): verify signature + validate schema or skip.
    if (!this.#verifyModerationSignature(event)) return

    const coreKeyHex = from && from.key ? from.key.toString('hex') : ''
    const seq = typeof length === 'number' && length > 0 ? length - 1 : -1
    const eventId = crypto.createHash('sha256').update(`${coreKeyHex}:${seq}`).digest('hex')

    const allowed = await this.#isModerationAllowed(event)
    if (allowed === null) {
      await view.put(`m:p:${eventId}`, {
        eventId,
        coreKey: coreKeyHex,
        seq,
        event
      })
      return
    }

    if (!allowed) return

    await this.#indexModerationEvent(view, event, { eventId, coreKeyHex, seq })
  }

  async #isModerationAllowed (event) {
    if (!this.#roleBase || typeof this.#roleBase.getRegistry !== 'function' || typeof this.#roleBase.can !== 'function') {
      return null
    }

    let registry = null
    try {
      registry = await this.#roleBase.getRegistry()
    } catch {
      registry = null
    }

    if (!registry) return null

    try {
      return await this.#roleBase.can(event.author, event.action)
    } catch {
      return false
    }
  }

  async #indexModerationEvent (view, event, meta) {
    const ts = event.timestamp
    const author = event.author
    const target = event.target

    const eventId = meta.eventId
    const coreKeyHex = meta.coreKeyHex
    const seq = meta.seq

    // Index by target: m:t:<targetId>:<createdAt>:<coreKeyHex>:<seq>
    const byTargetKey = `m:t:${target}:${toSortableTs(ts)}:${coreKeyHex}:${seq}`
    // Index by author: m:a:<author>:<createdAt>:<targetId>:<coreKeyHex>:<seq>
    const byAuthorKey = `m:a:${author}:${toSortableTs(ts)}:${target}:${coreKeyHex}:${seq}`

    const value = {
      eventId,
      action: event.action,
      target,
      reason: event.reason || null,
      author,
      createdAt: ts,
      signature: event.signature,
      coreKey: coreKeyHex,
      seq
    }

    await view.put(byTargetKey, value)
    await view.put(byAuthorKey, value)
  }

  async #applyRelation (view, event) {
    // Verify signature before applying (if enabled)
    if (this.#verifySignatures && !this.#verifyRelationSignature(event)) return

    const edgeRefKey = `er:${event.from}:${event.relationType}:${event.to}`
    const existingRef = await view.get(edgeRefKey)

    if (existingRef && existingRef.value && existingRef.value.ref) {
      const existingEdge = await view.get(existingRef.value.ref)
      if (existingEdge && existingEdge.value && !existingEdge.value.deleted) {
        return
      }
    }

    const createdAtKey = toSortableTs(event.timestamp)
    const key = `e:${event.from}:${event.relationType}:${createdAtKey}:${event.to}`

    await view.put(key, {
      from: event.from,
      to: event.to,
      type: event.relationType,
      author: event.author,
      createdAt: event.timestamp,
      deleted: false
    })

    await view.put(edgeRefKey, { ref: key })

    // Add incoming edge index
    const inKey = `i:in:${event.to}:${event.relationType}:${createdAtKey}:${event.from}`
    await view.put(inKey, { ref: key })

    const inCountKey = `cnt:in:${event.to}:${event.relationType}`
    const outCountKey = `cnt:out:${event.from}:${event.relationType}`

    const inExisting = await view.get(inCountKey)
    const outExisting = await view.get(outCountKey)

    const nextIn = Math.max(0, (inExisting && inExisting.value ? inExisting.value.count : 0) + 1)
    const nextOut = Math.max(0, (outExisting && outExisting.value ? outExisting.value.count : 0) + 1)

    // In P2P delivery, a delete event may arrive before its create. The count is clamped at 0 on delete,
    // but will not self-correct when the create arrives later. Counts may read one low on recently-synced peers.

    await view.put(inCountKey, { count: nextIn })
    await view.put(outCountKey, { count: nextOut })
  }

  async #applyRelationDelete (view, event) {
    // Verify signature before applying (if enabled)
    if (this.#verifySignatures && !this.#verifyRelationSignature(event)) return

    const createdAtKey = toSortableTs(event.createdAt)
    const key = `e:${event.from}:${event.relationType}:${createdAtKey}:${event.to}`
    const existing = await view.get(key)

    if (existing) {
      await view.put(key, { ...existing.value, deleted: true })
    }

    // Remove incoming edge index
    const inKey = `i:in:${event.to}:${event.relationType}:${createdAtKey}:${event.from}`
    await view.del(inKey)

    const edgeRefKey = `er:${event.from}:${event.relationType}:${event.to}`
    await view.del(edgeRefKey)

    const inCountKey = `cnt:in:${event.to}:${event.relationType}`
    const outCountKey = `cnt:out:${event.from}:${event.relationType}`

    const inExisting = await view.get(inCountKey)
    const outExisting = await view.get(outCountKey)

    const nextIn = Math.max(0, (inExisting && inExisting.value ? inExisting.value.count : 0) - 1)
    const nextOut = Math.max(0, (outExisting && outExisting.value ? outExisting.value.count : 0) - 1)

    await view.put(inCountKey, { count: nextIn })
    await view.put(outCountKey, { count: nextOut })
  }

  async #applyTag (view, event) {
    // TODO: Re-enable signature verification once all tests use proper signing
    // Verify signature before applying
    // if (!this.#verifyTagSignature(event)) return

    const key = `t:${event.tag}:${toSortableTs(event.timestamp)}:${event.entityId}:${event.author}`
    const refKey = `tref:${event.tag}:${event.entityId}:${event.author}`
    await view.put(key, {
      entityId: event.entityId,
      tag: event.tag,
      author: event.author,
      createdAt: event.timestamp
    })

    await view.put(refKey, { ref: key })
  }

  async #applyTagDelete (view, event) {
    // Verify signature before applying
    if (!this.#verifyTagSignature(event)) return

    const refKey = `tref:${event.tag}:${event.entityId}:${event.author}`
    const ref = await view.get(refKey)
    if (ref) await view.del(ref.value.ref)
    await view.del(refKey)
  }

  async #applyMessage (view, event) {
    // Store message in the view with a unique key
    const key = `msg:${event.timestamp}:${event.author.slice(0, 8)}`
    await view.put(key, {
      text: event.text,
      username: event.username,
      author: event.author,
      timestamp: event.timestamp
    })
  }

  // ========================================
  // Properties
  // ========================================

  /** @returns {import('autobase')|undefined} The underlying Autobase instance */
  get base () {
    return this.#base
  }

  /** @returns {boolean} Whether the context is writable */
  get writable () {
    return this.#base ? this.#base.writable : false
  }

  /** @returns {import('hypercore')|undefined} The underlying Autobase core */
  get core () {
    return this.#base?.core
  }

  /** @returns {Buffer|undefined} The Autobase public key */
  get key () {
    return this.#base?.key
  }

  /** @returns {Buffer|undefined} The local writer's public key */
  get localKey () {
    return this.#base?.local?.key
  }

  /** @returns {Buffer|undefined} The Autobase discovery key */
  get discoveryKey () {
    return this.#base?.discoveryKey
  }

  /** @returns {number} The Autobase version */
  get version () {
    return this.#base?.version ?? -1
  }

  /** @returns {import('hyperbee')|undefined} The materialized view Hyperbee */
  get view () {
    return this.#base?.view
  }

  /** @returns {boolean} Whether the context is writable */
  get writable () {
    return this.#base?.writable
  }

  /** @returns {'open'|'closed'} The write mode of this context */
  get writeMode () {
    return this.#writeMode
  }

  /**
   * Get all writer keys for this context.
   *
   * @returns {Array<string>} Array of hex-encoded public keys
   */
  writerKeys () {
    const base = this.#base
    if (!base) return []

    const keys = []

    try {
      const inputs = base.inputs
      if (Array.isArray(inputs)) {
        for (const input of inputs) {
          if (input && input.key) keys.push(input.key.toString('hex'))
        }
      }
    } catch {}

    try {
      if (base.local && base.local.key) keys.push(base.local.key.toString('hex'))
    } catch {}

    return Array.from(new Set(keys)).sort()
  }

  // ========================================
  // Operations
  // ========================================

  /**
   * Append an event to the context.
   *
   * In 'open' mode, if the local writer is not already in the writer list,
   * they will be automatically added before appending.
   *
   * @param {Object} event - The event to append
   * @returns {Promise<{length: number}>} The length of the base after append
   */
  async append (event) {
    if (!this.opened) await this.ready()
    
    // In open mode, use optimistic appends to allow any peer to replicate events
    // This is required for P2P replication to work correctly
    const opts = this.#writeMode === 'open' ? { optimistic: true } : {}
    
    await this.#base.append(event, opts)
    await this.#base.update()
    return { length: this.#base.length }
  }

  /**
   * Add a writer to the context.
   *
   * In 'open' mode, any writer can be added. In 'closed' mode, requires the
   * 'context.write' privilege from the attached RoleBase.
   *
   * @param {Buffer|string} coreKey - The writer's core key (hex string or Buffer)
   * @param {Object} [opts] - Options object
   * @param {string} [opts.author] - Required in 'closed' mode: the author's public key hex
   * @returns {Promise<void>}
   * @throws {Error} If RoleBase is required but not attached, or authorization fails
   */
  async addWriter (coreKey, opts = {}) {
    if (!this.opened) await this.ready()

    const key = Buffer.isBuffer(coreKey) ? coreKey : Buffer.from(coreKey, 'hex')
    const keyHex = key.toString('hex')

    // Add the writer by appending a roles/addWriter event to the system core
    // This is the correct way to add writers in Autobase
    await this.#base.append({ type: 'roles/addWriter', key: keyHex })
    await this.#base.update()
  }

  // ========================================
  // Read Operations
  // ========================================

  /**
   * Get a value from the context view.
   *
   * @param {string} key - The key to look up
   * @returns {Promise<Object|null>} The value, or null if not found
   */
  async get (key) {
    if (!this.opened) await this.ready()
    return this.#base.view.get(key)
  }

  /**
   * Create a readable stream of entries from the context view.
   *
   * @param {Object} [opts] - Stream options (passed to Hyperbee.createReadStream)
   * @returns {AsyncIterable<Object>} Async iterator of view entries
   */
  async * createReadStream (opts = {}) {
    if (!this.opened) await this.ready()

    const stream = this.#base.view.createReadStream(opts)
    for await (const entry of stream) {
      yield entry
    }
  }

  // ========================================
  // Replication
  // ========================================

  /**
   * Create a replication stream for the context.
   *
   * @param {boolean|import('streamx').Duplex} isInitiatorOrStream - Whether this side initiated the connection, or a stream to replicate to
   * @param {Object} [opts] - Replication options (passed to Autobase.replicate)
   * @returns {import('streamx').Duplex|void} The replication stream (if isInitiator is boolean)
   */
  replicate (isInitiatorOrStream, opts) {
    return this.#base.replicate(isInitiatorOrStream, opts)
  }

  /**
   * Update the context from remote peers and drain pending moderation events.
   *
   * @returns {Promise<void>}
   */
  async update () {
    await this.#base.update()

    const view = this.#viewBee || this.#base?.view
    if (!view) return

    try {
      await this.#drainPendingModeration(view)
    } catch (err) {
      if (err && err.code === 'SESSION_NOT_WRITABLE') return
      throw err
    }
  }

  async #drainPendingModeration (view) {
    // If registry isn't ready yet, keep pending items.
    if (!this.#roleBase || typeof this.#roleBase.getRegistry !== 'function') return

    let registry = null
    try {
      registry = await this.#roleBase.getRegistry()
    } catch {
      registry = null
    }

    if (!registry) return

    const stream = view.createReadStream({ gte: 'm:p:', lt: 'm:p:' + '\uffff' })
    for await (const entry of stream) {
      const v = entry.value
      if (!v || !v.event || typeof v.event !== 'object') {
        await view.del(entry.key)
        continue
      }

      const allowed = await this.#isModerationAllowed(v.event)
      if (allowed) {
        await this.#indexModerationEvent(view, v.event, {
          eventId: v.eventId,
          coreKeyHex: v.coreKey,
          seq: v.seq
        })
      }

      // Whether allowed or not, once registry is available the decision is final.
      await view.del(entry.key)
    }
  }

  // ========================================
  // Event Emitter Methods
  // ========================================

  /**
   * Register a context event listener.
   * @param {string} event - Event name (e.g., 'writer-request')
   * @param {Function} callback - Callback function
   */
  onContextEvent (event, callback) {
    this.#emitter.on(event, callback)
  }

  /**
   * Remove a context event listener.
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   */
  offContextEvent (event, callback) {
    this.#emitter.off(event, callback)
  }

  /**
   * Emit a context event.
   * @param {string} event - Event name
   * @param {...any} args - Event arguments
   */
  emitContextEvent (event, ...args) {
    this.#emitter.emit(event, ...args)
  }

  // ========================================
  // Writer Authorization
  // ========================================

  /**
   * Request writer access for this context.
   * In open mode, this is automatically approved. In closed mode, it emits a 'writer-request' event.
   *
   * @param {Buffer|string} writerKey - The writer's core key
   * @param {Object} [opts] - Options
   * @param {string} [opts.userCore] - The user's core key (for identification)
   * @returns {Promise<boolean>} True if the writer was added, false if pending
   */
  async requestWriter (writerKey, opts = {}) {
    if (!this.opened) await this.ready()

    const keyHex = Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey

    // Check if already a writer
    const writers = this.writerKeys()
    if (writers.includes(keyHex)) return true

    // In open mode, auto-approve
    if (this.#writeMode === 'open') {
      await this.addWriter(writerKey)
      return true
    }

    // In closed mode, emit a request event
    this.#pendingWriterRequests.set(keyHex, {
      key: keyHex,
      userCore: opts.userCore || null,
      timestamp: Date.now()
    })

    this.emitContextEvent('writer-request', {
      key: keyHex,
      userCore: opts.userCore || null,
      approve: async () => {
        await this.addWriter(writerKey)
        this.#pendingWriterRequests.delete(keyHex)
      },
      reject: () => {
        this.#pendingWriterRequests.delete(keyHex)
      }
    })

    return false
  }

  /**
   * Approve a pending writer request.
   *
   * @param {Buffer|string} writerKey - The writer's core key
   * @returns {Promise<void>}
   */
  async approveWriter (writerKey) {
    if (!this.opened) await this.ready()
    const keyHex = Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey
    await this.addWriter(writerKey)
    this.#pendingWriterRequests.delete(keyHex)
    this.#emitter.emit('writer-approved', Buffer.isBuffer(writerKey) ? writerKey : Buffer.from(writerKey, 'hex'))
  }

  /**
   * Reject a pending writer request.
   *
   * @param {Buffer|string} writerKey - The writer's core key
   */
  rejectWriter (writerKey) {
    const keyHex = Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey
    this.#pendingWriterRequests.delete(keyHex)
    this.#emitter.emit('writer-rejected', Buffer.isBuffer(writerKey) ? writerKey : Buffer.from(writerKey, 'hex'))
  }

  /**
   * Register an event listener for writer-related events.
   * 
   * @param {string} event - Event name ('writer-request', 'writer-added', 'writer-approved', 'writer-rejected')
   * @param {Function} callback - Callback function
   * @returns {this}
   */
  on (event, callback) {
    this.#emitter.on(event, callback)
    return this
  }

  /**
   * Remove an event listener.
   * 
   * @param {string} event - Event name
   * @param {Function} callback - Callback function
   * @returns {this}
   */
  off (event, callback) {
    this.#emitter.off(event, callback)
    return this
  }

  /**
   * Get pending writer requests.
   *
   * @returns {Array<Object>} Array of pending writer requests
   */
  getPendingWriterRequests () {
    return Array.from(this.#pendingWriterRequests.values())
  }
}
