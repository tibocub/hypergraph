const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const b4a = require('b4a')
const { resolveOpenContexts, authorFromEntityId } = require('./utils')
const tuning = require('./tuning')
const L = require('./index-layout/graph')

const HEX64 = /^[0-9a-f]{64}$/

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
  #writer // the open Hyperbee batch while a user core is being indexed, else null
  #updating // tail of the chain that serializes update() passes
  #onIndexEvent // test-only hook, see constructor

  /**
   * Create a new GraphView instance.
   *
   * @param {Object} bee - The Hyperbee instance for the view (binary keys
   *   and values, layout 2: see src/index-layout/graph.js)
   * @param {Map} userCores - Map of user core keys to UserCore instances
   * @param {Map} contexts - Map of context names to ContextBase instances
   * @param {Object} [opts]
   * @param {Function} [opts.onIndexEvent] - Test-only: called after each
   *   user-core event is applied, before it is committed. Throwing from it
   *   simulates a crash mid-pass.
   */
  constructor (bee, userCores, contexts, opts = {}) {
    super()

    this.#bee = bee
    this.#userCores = userCores
    this.#contexts = contexts
    this.#lastProcessedSeq = new Map()
    this.#contextCheckpoints = new Map()
    this.#userMetaKey = null
    this.#deviceToIdentity = new Map()
    this.#writer = null
    this.#updating = Promise.resolve()
    this.#onIndexEvent = opts.onIndexEvent || null

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
    if (typeof pubkey !== 'string' || !HEX64.test(pubkey)) return null
    const entry = await this.#bee.get(L.profileKey(pubkey))
    if (!entry) return null
    const { seq, username, bio } = L.decodeProfile(entry.value)
    return { author: pubkey, username, bio, seq }
  }

  async _open () {
    for (const [keyHex, core] of this.#userCores) {
      if (!core.key) throw new Error('UserCore key missing')
      this.#lastProcessedSeq.set(keyHex, await this.#readUserProgress(keyHex))
    }
  }

  // The last indexed seq of a user log, or -1.
  async #readUserProgress (keyHex) {
    const entry = await this.#bee.get(L.userProgressKey(keyHex))
    return entry ? L.decodeCount(entry.value) : -1
  }

  async _close () {
    // Nothing to close, bee is managed by Hypergraph
  }

  // Where apply functions read and write: the open batch while indexing a
  // user core (so reads see the batch's own pending entries), else the bee.
  get #db () {
    return this.#writer || this.#bee
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
   * @returns {Promise<boolean>} True if any new user-core or context-view
   *   data was actually processed this call, false if there was nothing
   *   new. Used by Hypergraph.update() to know when to emit a 'change'
   *   event for live queries — this is a coarse, "something changed"
   *   signal, not a per-entity/per-relation one.
   */
  async update () {
    if (!this.opened) await this.ready()

    // One pass at a time. Each pass indexes through its own Hyperbee batch,
    // and two passes over the same range would also both start from the
    // same progress record. A call made while a pass is running runs after
    // it, so it still picks up whatever arrived in the meantime.
    const run = this.#updating.then(() => this.#update())
    this.#updating = run.catch(safetyCatch)
    return run
  }

  async #update () {
    let changed = false

    // Ensure replicated data is pulled in before indexing.
    // wait:false: core.update() with no options blocks indefinitely if the
    // core's replicator believes it's still finding peers (confirmed by
    // reading Hypercore's own update()/_shouldWait() implementation) — for
    // example a user core only reachable via relay through another peer,
    // not a direct connection. That would hang this entire view update
    // waiting on one specific core, even when other cores/contexts here
    // have data ready to process right now. This should be a "check what's
    // available" operation, not a "block until something arrives" one.
    for (const [keyHex, core] of this.#userCores) {
      await core.update({ wait: false })

      // addUserCore() loads this in the background; don't race it into
      // re-indexing from 0.
      if (!this.#lastProcessedSeq.has(keyHex)) {
        const seq = await this.#readUserProgress(keyHex)
        if (!this.#lastProcessedSeq.has(keyHex)) this.#lastProcessedSeq.set(keyHex, seq)
      }
      const lastSeq = this.#lastProcessedSeq.get(keyHex)
      const currentLength = core.length
      if (currentLength <= lastSeq + 1) continue

      if (await this.#indexUserCore(keyHex, core, lastSeq, currentLength)) changed = true
    }

    // Contexts apply on their own: Autobase applies as data arrives, and
    // Hypergraph.update() and local appends call context.update(). Here we
    // only note which context views grew, for the 'change' signal. This
    // runs after every local write too, so it must cost nothing for a
    // context that didn't change: no context.update(), no write
    // (bench/channels.js: 200 idle channels cost 121 ms per update before).
    for (const [, context] of this.#contexts) {
      if (!context.opened) continue

      const viewCore = context.view?.core
      if (!viewCore) continue

      const viewKeyHex = viewCore.key.toString('hex')
      const metaKey = L.contextProgressKey(viewKeyHex)

      // If we have not loaded the checkpoint for this view yet, load it lazily.
      if (!this.#contextCheckpoints.has(viewKeyHex)) {
        const v = await this.#bee.get(metaKey)
        this.#contextCheckpoints.set(viewKeyHex, v ? L.decodeCount(v.value) : -1)
      }

      const viewLen = viewCore.length
      if (viewLen === this.#contextCheckpoints.get(viewKeyHex)) continue

      changed = true
      this.#contextCheckpoints.set(viewKeyHex, viewLen)
      await this.#bee.put(metaKey, L.encodeCount(viewLen))
    }

    return changed
  }

  /**
   * Index events [lastSeq + 1, currentLength) of one user core.
   *
   * Index entries are written through a Hyperbee batch committed every
   * `tuning.INDEX_BATCH` events: one hypercore append (one hash, one
   * signature, one flush) per chunk instead of one per entry, which was the
   * single largest indexing cost (specs/002-scale-indexing/research.md R1).
   * The progress record goes into the same batch, so a chunk's entries and
   * the record that says they exist are committed together - an
   * interruption loses at most the uncommitted chunk, which the next pass
   * redoes from the last committed record. Readers see each chunk as it is
   * committed, not only when the whole pass ends.
   *
   * @returns {Promise<boolean>} Whether anything was indexed.
   */
  async #indexUserCore (keyHex, core, lastSeq, currentLength) {
    const metaKey = L.userProgressKey(keyHex)
    let committed = lastSeq
    let lastProcessed = lastSeq
    let prefetchedTo = this.#prefetch(core, lastSeq + 1, currentLength)

    const commit = async () => {
      await this.#writer.put(metaKey, L.encodeCount(lastProcessed))
      await this.#writer.flush()
      committed = lastProcessed
      this.#lastProcessedSeq.set(keyHex, committed)
      this.#writer = this.#bee.batch()
    }

    this.#writer = this.#bee.batch()
    try {
      for (let i = lastSeq + 1; i < currentLength; i++) {
        if (prefetchedTo < currentLength && i >= prefetchedTo - tuning.PREFETCH_WINDOW / 2) {
          prefetchedTo = this.#prefetch(core, prefetchedTo, currentLength)
        }

        // core.get(i) with no options blocks indefinitely if the block
        // hasn't actually arrived yet, even though the core's length
        // metadata has already synced (confirmed by reading Hypercore's
        // own get()/_get() implementation: with no timeout, the block
        // request has no bound at all). A timeout still issues the
        // request - so the block can still arrive later in the
        // background - without blocking this whole view update forever.
        // If it times out, stop processing further events for this core
        // in this call; a later update() call will pick up where this one
        // left off once the block has arrived.
        let event
        try {
          event = await core.get(i, { timeout: 5000 })
        } catch (err) {
          safetyCatch(err)
          break
        }
        if (event === null) break
        await this.#applyEvent(event, i, keyHex)
        lastProcessed = i
        if (this.#onIndexEvent) this.#onIndexEvent(i, keyHex)

        if (lastProcessed - committed >= tuning.INDEX_BATCH) await commit()
      }

      if (lastProcessed > committed) await commit()
    } finally {
      // Discards whatever was not committed (only non-empty on a throw).
      const writer = this.#writer
      this.#writer = null
      await writer.close()
    }

    return lastProcessed > lastSeq
  }

  /**
   * Ask peers for up to `tuning.PREFETCH_WINDOW` blocks of another user's
   * log at once, instead of one network round trip per block as the
   * indexing loop reaches it. Never awaited: a block no connected peer has
   * must not hold up the update, and the loop's own get() timeout already
   * handles a block that doesn't arrive (research R4).
   *
   * @returns {number} The end of the requested range.
   */
  #prefetch (core, start, currentLength) {
    const end = Math.min(currentLength, start + tuning.PREFETCH_WINDOW)
    const hypercore = core.core
    if (!hypercore || core.writable || start >= end) return end
    try {
      hypercore.download({ start, end }).done().catch(safetyCatch)
    } catch (err) {
      safetyCatch(err)
    }
    return end
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
        await this.#applyContentAppend(event, seq, coreKeyHex)
        break
      case 'identity/update':
        await this.#applyIdentityUpdate(event, seq, coreKeyHex)
        break
    }
  }

  async #applyIdentityUpdate (event, seq, coreKeyHex) {
    if (event.author !== coreKeyHex) return

    await this.#db.put(L.profileKey(event.author), L.encodeProfile({
      seq,
      username: event.username,
      bio: event.bio || null
    }))
  }

  async #applyEntityCreate (event, seq, coreKeyHex) {
    // Binding invariant: entities are authored by the owner of the core they live in.
    if (event.author !== coreKeyHex) return

    // The id is derived, never taken from the event: <type>/<core key>/<seq>.
    const p = L.parseEntityId(`${event.entityType}/${coreKeyHex}/${seq}`)
    if (!p) return

    const key = L.nodeKey(p)
    const existing = await this.#db.get(key)

    // Entities are immutable once created.
    // If it already exists, ignore subsequent creates.
    if (existing && !L.decodeNode(existing.value).deleted) return

    await this.#db.put(key, L.encodeNode({ createdAt: event.timestamp, deleted: false }))

    // By type, then creation time: makes by-type scans a single range.
    await this.#db.put(L.nodeByTypeKey(p, event.timestamp), L.EMPTY)

    // By creation time, across all types. The node index itself is ordered
    // by (type, author, seq) - not chronological once more than one author
    // is involved, since a core key is effectively random relative to when
    // its owner wrote something. This one gives a real chronological scan
    // without loading and sorting every entity.
    await this.#db.put(L.nodeByTimeKey(p, event.timestamp), L.EMPTY)
  }

  async #applyEntityTombstone (event, coreKeyHex) {
    // Binding invariant: only the owner of the core can tombstone entities in that core.
    if (event.author !== coreKeyHex) return

    // Tombstone ids must be in derived form and name this core as author.
    const p = L.parseEntityId(event.id)
    if (!p || p.author.toString('hex') !== coreKeyHex) return

    const key = L.nodeKey(p)
    const existing = await this.#db.get(key)

    if (existing) {
      const node = L.decodeNode(existing.value)
      await this.#db.put(key, L.encodeNode({ createdAt: node.createdAt, deleted: true, deletedAt: event.timestamp }))
    }
  }

  async #applyContentAppend (event, seq, coreKeyHex) {
    // Binding invariant: content can only be appended under the entity's own
    // author's core - same rule as entity/create and entity/tombstone above.
    // Without this, any peer could forge content for any entityId simply by
    // appending a content/append event naming that id from their own core.
    if (authorFromEntityId(event.entityId) !== coreKeyHex) return
    const p = L.parseEntityId(event.entityId)
    if (!p) return

    // A pointer, not a copy: getContent() reads the event back from this
    // core at `seq`. The seq is a number key member, so the newest version
    // is simply the last key of the entity's range.
    await this.#db.put(L.contentKey(p, seq), L.EMPTY)
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
      const seq = await this.#readUserProgress(keyHex)
      if (!this.#lastProcessedSeq.has(keyHex)) {
        this.#lastProcessedSeq.set(keyHex, seq)
      }
    }).catch(safetyCatch) // the graph may close before this read finishes
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

      const v = await this.#bee.get(L.contextProgressKey(viewKeyHex))
      if (this.#contextCheckpoints.has(viewKeyHex)) return
      this.#contextCheckpoints.set(viewKeyHex, v ? L.decodeCount(v.value) : -1)
    }).catch(safetyCatch) // the graph may close before this read finishes
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

    const p = L.parseEntityId(id)
    if (!p) return null // every indexed entity has a derived id
    const entry = await this.#bee.get(L.nodeKey(p))
    if (!entry) return null
    const node = L.decodeNode(entry.value)
    if (node.deleted) return null
    return {
      id,
      type: p.type,
      author: p.author.toString('hex'),
      createdAt: node.createdAt,
      deleted: false,
      version: p.seq
    }
  }

  /**
   * Get the latest content version for an entity.
   *
   * @param {string} entityId - The entity ID
   * @returns {Promise<{ contentType: string, body: string }|null>} The content, or null if not found
   */
  async getContent (entityId) {
    if (!this.opened) await this.ready()

    const p = L.parseEntityId(entityId)
    if (!p) return null

    // The newest version is the last key of the entity's range.
    let contentSeq = -1
    for await (const entry of this.#bee.createReadStream({ ...L.contentRange(p), reverse: true, limit: 1 })) {
      contentSeq = L.contentSeqFromKey(entry.key)
    }
    if (contentSeq === -1) return null

    // The body lives in the author's log, which this peer indexed it from.
    // If that log is not open here or the block is no longer held, there
    // is nothing to show.
    const userCore = this.#userCores.get(p.author.toString('hex'))
    if (!userCore) return null
    let event
    try {
      event = await userCore.get(contentSeq, { wait: false })
    } catch (err) {
      safetyCatch(err)
      return null
    }
    if (!event || event.type !== 'content/append' || event.entityId !== entityId) return null

    const encrypted = event.encrypted === true
    return {
      entityId,
      contentType: event.contentType,
      body: event.body,
      createdAt: event.timestamp,
      // When encrypted, `body` holds a hex ciphertext rather than plaintext;
      // contentType stays in the clear (only the payload is encrypted).
      encrypted,
      scope: encrypted ? event.scope : null,
      epoch: encrypted ? event.epoch : null,
      nonce: encrypted ? event.nonce : null
    }
  }

  /**
   * Get edges for an entity.
   *
   * @param {string} entityId - The entity ID
   * @param {EdgeQueryOpts} [opts] - Query options
   * @returns {AsyncIterable<Edge>} Async iterator of edges
   */
  /**
   * @param {string} entityId
   * @param {Object} [opts]
   * @param {'in'|'out'} [opts.direction='out']
   * @param {string} [opts.type]
   * @param {string|string[]} [opts.context] - Restrict to this context (or
   *   these contexts). Required if more than one context is open on this
   *   graph instance - see #resolveContexts.
   * @param {boolean} [opts.allContexts] - Explicitly query across every open
   *   context instead of requiring `context` to be named.
   * @param {number} [opts.limit]
   * @param {'asc'|'desc'} [opts.order]
   * @param {boolean} [opts.reverse]
   * @param {boolean} [opts.latestPerAuthor] - Reduce results to only the
   *   most recent edge per author (by createdAt). Useful for any "one fact
   *   per author per target" pattern — e.g. a vote, rating, or presence
   *   marker — where an author may have created multiple edges over time
   *   (there is no built-in uniqueness constraint across those) but only
   *   their latest one should count. This buffers all matching edges in
   *   memory before yielding, unlike the normal streaming path.
   */
  async * getEdges (entityId, opts = {}) {
    if (!opts.latestPerAuthor) {
      yield * this.#getEdgesRaw(entityId, opts)
      return
    }

    const latestByAuthor = new Map()
    for await (const edge of this.#getEdgesRaw(entityId, opts)) {
      const existing = latestByAuthor.get(edge.author)
      if (!existing || (edge.createdAt || 0) > (existing.createdAt || 0)) {
        latestByAuthor.set(edge.author, edge)
      }
    }
    yield * latestByAuthor.values()
  }

  async * #getEdgesRaw (entityId, opts = {}) {
    if (!this.opened) await this.ready()

    const direction = opts.direction || 'out'
    const type = opts.type
    const limit = typeof opts.limit === 'number' ? opts.limit : null
    const order = opts.order
    const reverse = typeof opts.reverse === 'boolean'
      ? opts.reverse
      : (order === 'desc')

    // An edge's `author` is only ever the signer of the edge event itself
    // (verified by #verifyRelationSignature at apply time) — relate() does
    // not, and cannot cheaply, check that the caller actually owns
    // `opts.from`. So without this check, anyone could sign a perfectly
    // valid edge event claiming `from: <someone else's entity>`, and it
    // would apply and appear here as if that entity really pointed at it.
    // This mirrors the same defensive re-check getByTag() already does for
    // tags (`node.author === entry.value.author`) — same underlying gap,
    // same fix, applied where edges are actually read. Checked via
    // authorFromEntityId() (the id itself embeds its author) rather than
    // getNode(), so it works with no dependency on having that author's
    // UserCore open/replicated locally - e.g. tallying votes on a popular
    // post shouldn't require opening every voter's UserCore.
    const fromIsGenuine = (from, claimedAuthor) => authorFromEntityId(from) === claimedAuthor

    for (const [name, context] of resolveOpenContexts(this.#contexts, opts)) {
      if (!context.opened) continue

      // Ordered by (entity, type, createdAt, other end), in the context's
      // own index layout.
      const edges = context.indexedEdges(entityId, { direction, type, reverse, limit: limit || undefined })
      for await (const edge of edges) {
        if (edge.deleted) continue
        if (!fromIsGenuine(edge.from, edge.author)) continue
        yield edge
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
   * @param {string|string[]} [opts.context] - Restrict to this context (or
   *   these contexts). Required if more than one context is open on this
   *   graph instance - see #resolveContexts.
   * @param {boolean} [opts.allContexts] - Explicitly query across every open
   *   context instead of requiring `context` to be named.
   * @returns {AsyncIterable<Entity>} Async iterator of entities with the tag
   */
  async * getByTag (tag, opts = {}) {
    if (!this.opened) await this.ready()

    const authors = opts.authors || (opts.author ? [opts.author] : null)
    const allow = authors ? new Set(authors) : null

    for (const [name, context] of resolveOpenContexts(this.#contexts, opts)) {
      if (!context.opened) continue

      for await (const entry of context.tagged(tag)) {
        if (allow && !allow.has(entry.author)) continue
        const node = await this.getNode(entry.entityId)
        if (node && node.author === entry.author) {
          yield { ...node, tag: entry.tag }
        }
      }
    }
  }

  /**
   * Check whether an entity has been tagged with a given tag.
   *
   * Tag refs live in each ContextBase's own Hyperbee view (not the top-level
   * graph view). By default this checks the single open context (or throws
   * if more than one is open and neither `context` nor `allContexts` was
   * given) - see #resolveContexts.
   *
   * @param {string} entityId - The entity id to check
   * @param {string} tag - The tag to check for
   * @param {Object} [opts]
   * @param {string|string[]} [opts.context]
   * @param {boolean} [opts.allContexts]
   * @returns {Promise<boolean>}
   */
  async hasTag (entityId, tag, opts = {}) {
    if (!this.opened) await this.ready()

    for (const [name, context] of resolveOpenContexts(this.#contexts, opts)) {
      if (!context.opened) continue
      if (await context.hasTag(entityId, tag)) return true
    }

    return false
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
      for await (const entry of this.#bee.createReadStream(L.nodeRange())) {
        const node = await this.getNode(L.nodeIdFromKey(entry.key))
        if (node) yield node
      }
      return
    }

    for await (const id of this.nodeIds({ type })) {
      const node = await this.getNode(id)
      if (node) yield node
    }
  }

  /**
   * Entity ids in creation-time order, of one type or of all types.
   * Deleted entities are included; resolve each with getNode().
   *
   * @param {Object} [opts]
   * @param {string} [opts.type]
   * @param {boolean} [opts.reverse]
   * @returns {AsyncIterable<string>}
   */
  async * nodeIds (opts = {}) {
    if (!this.opened) await this.ready()
    const typed = opts.type != null
    const range = typed ? L.nodeByTypeRange(opts.type) : L.nodeByTimeRange()
    for await (const entry of this.#bee.createReadStream({ ...range, reverse: !!opts.reverse })) {
      yield typed ? L.nodeIdFromTypeKey(entry.key) : L.nodeIdFromTimeKey(entry.key)
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
  /**
   * Get entities by author (hex public key).
   *
   * Scans the author's own UserCore directly, rather than the shared
   * view — a UserCore already only contains that person's own entities,
   * so no separate author index is needed at all. Returns nothing if this
   * author's core hasn't been opened/replicated locally yet.
   *
   * @param {string} author - The author's hex public key
   * @returns {AsyncIterable<Entity>} Async iterator of entities by the author
   */
  async * getByAuthor (author) {
    if (!this.opened) await this.ready()

    const userCore = this.#userCores.get(author)
    if (!userCore) return

    for (let seq = 0; seq < userCore.length; seq++) {
      const event = await userCore.get(seq)
      if (!event || event.type !== 'entity/create') continue

      const id = `${event.entityType}/${author}/${seq}`
      const node = await this.getNode(id)
      if (node) yield node
    }
  }

  /**
   * Create a readable stream from the underlying Hyperbee. Keys and values
   * are raw layout-2 buffers (src/index-layout/graph.js).
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
