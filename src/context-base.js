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
const { toSortableTs, stableTagHash, stableRelationHash, stableContextHash, authorFromEntityId, relationDataProblem } = require('./utils')
const rolesRegistry = require('./roles-registry')
const tuning = require('./tuning')
const { layoutFor, KNOWN_LAYOUTS } = require('./index-layout/context')

// hypergraph://invite/<contextKeyHex>/<secretSeedHex> (spec 006)
const INVITE_LINK = /^hypergraph:\/\/invite\/([0-9a-f]{64})\/([0-9a-f]{64})$/

/**
 * Parse an invite link.
 *
 * @param {string} link
 * @returns {{ context: string, seed: string, inviteKey: string }}
 */
function parseInviteLink (link) {
  const m = typeof link === 'string' ? INVITE_LINK.exec(link.trim()) : null
  if (!m) throw new Error('Not an invite link (expected hypergraph://invite/<context>/<secret>)')
  const inviteKey = b4a.toString(hypercoreCrypto.keyPair(b4a.from(m[2], 'hex')).publicKey, 'hex')
  return { context: m[1], seed: m[2], inviteKey }
}

// Where a context's topology record lives in its view (spec 003).
const CONTEXT_RECORD_KEY = 'meta:context'
// A version 3 context's own role table (spec 005).
const ROLES_KEY = 'meta:roles'
const HEX64 = /^[0-9a-f]{64}$/
// Context versions this code can apply.
const KNOWN_VERSIONS = [1, 2, 3]

// The default role table of a version 3 context: the role registry's own
// defaults, plus indexing for admins (owners have '*').
function defaultRoleTable (owner) {
  const table = rolesRegistry.initRegistry(owner)
  table.roles.admin = [...table.roles.admin, 'context.index']
  return table
}

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * ContextBase manages collaborative contexts using Autobase.
 *
 * A context is an Autobase instance used to store collaborative events (relations, tags, moderation, etc).
 * Supports two write modes: 'open' (no read/write privilege checks) and 'closed' (role-based read/write permissions). Both can use roles and moderation.
 *
 * @extends ReadyResource
 */
class ContextBase extends ReadyResource {
  #store
  #bootstrap
  #namespace
  #base
  #viewBee
  #counts // edge counters pending for the current apply chunk, else null
  #applyIndex // the index layout apply is writing with (src/index-layout/context.js)
  #index // the index layout readers use, once this view's record says which
  #scopes // the graph's ScopeBase/RoleBase, for invites that ask for a scope (spec 006 US3)
  #localLayout // where this peer remembers the context's index layout, outside the shared view
  #prefetchedAt = -1 // view length when the control records were last fetched
  #members // every member the system listed at the last update(), see writerKeys()
  #fastForward
  #fastForwards // how many times this peer fast-forwarded, reported by status()
  #membersDirty = true // the member list may have changed since writerKeys() last read it
  #membersCount = -1 // the system's member count when it was last read
  #moderationQueued = true // pending moderation may exist (checked once after open)
  #rules // app rules { id, validate } or null (spec 003, US3)
  #wakeup // shared writer-discovery protocol from Hypergraph, or null (spec 006)
  #interrupted // why this context stopped applying, or null
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
   * @param {Object} store - Corestore instance for core management
   * @param {Buffer|string|null} bootstrapKey - Autobase key to join existing context, or null to create new
   * @param {Object} [opts] - Configuration options
   * @param {string} [opts.keyEncoding] - Codec name for keys
   * @param {string} [opts.valueEncoding] - Codec name for values
   * @param {Object} [opts.roleBase] - Attached RoleBase for permission checks
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
    this.#scopes = opts.scopes || null
    this.#localLayout = opts.localLayout || null
    this.#writeMode = opts.writeMode === 'closed' ? 'closed' : 'open'
    this.#base = null
    this.#viewBee = null
    this.#members = []
    this.#pendingWriterRequests = new Map()
    this.#emitter = new EventEmitter()
    this.#verifySignatures = opts.verifySignatures !== undefined ? opts.verifySignatures : true
    // Join by adopting the indexers' signed state instead of replaying history
    // (spec 003). false: replay and verify everything on this peer.
    this.#fastForward = opts.fastForward !== false
    this.#fastForwards = 0
    this.#rules = opts.rules || null
    this.#wakeup = opts.wakeup || null
    this.#interrupted = null

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
      // No valueEncoding: Autobase gets bytes we encode ourselves (append)
      // and decode ourselves (#applyView). Autobase stores node values
      // verbatim either way, so the oplog bytes are identical to letting it
      // run our codec — but Autobase's batched append encodes an array as ONE
      // value with any non-binary encoding, which made batched appends
      // impossible. See specs/002-scale-indexing/research.md R3.
      // Indexers acknowledge new history so it becomes confirmed (signed) —
      // without this, multi-writer contexts never confirmed anything
      // (specs/003-fast-forward-contexts/research.md R1).
      ackInterval: tuning.ACK_INTERVAL,
      ackThreshold: 0,
      fastForward: this.#fastForward,
      // A peer that isn't a writer yet may append "optimistic" blocks; apply
      // accepts only valid invite redemptions among them (spec 006) and
      // ignores everything else, as it always has for non-writers.
      optimistic: true
    }
    // Writer discovery (Autobase's wakeup protocol) shared by every context of
    // this graph and attached to streams by graph.replicate(): without it a
    // peer never learns a redeemer's log exists.
    if (this.#wakeup) autobaseOpts.wakeup = this.#wakeup

    // Let Autobase handle local writer creation automatically
    // Closed mode enforcement is at the application level via role checks, not at Autobase level
    this.#base = new Autobase(ns, this.#bootstrap, autobaseOpts)
    this.#base.on('fast-forward', () => { this.#fastForwards++; this.#membersDirty = true })
    // Autobase closes the base after an interrupt (unknown context version,
    // rules mismatch): remember why, so status() and openContext() can say.
    this.#base.on('interrupt', (reason) => {
      this.#interrupted = String(reason)
      this.#emitter.emit('interrupt', this.#interrupted)
    })
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

  async #applyView (batch, rawView, rawHost) {
    // Every membership change goes through these two calls: noting it lets
    // update() skip re-reading the member list when nothing changed
    // (bench/members.js: the re-read cost 39 ms per update at 5,000 members).
    const host = {
      addWriter: (key, opts) => { this.#membersDirty = true; return rawHost.addWriter(key, opts) },
      removeWriter: (key) => { this.#membersDirty = true; return rawHost.removeWriter(key) },
      ackWriter: (key) => rawHost.ackWriter(key),
      removeable: (key) => rawHost.removeable(key),
      interrupt: (reason) => rawHost.interrupt(reason)
    }
    // Index writes go through a Hyperbee batch: one view append per chunk of
    // `tuning.INDEX_BATCH` events instead of one per entry (research R1/R2).
    // Chunked rather than one batch per apply call, so memory stays bounded
    // even when a writer (possibly a hostile one) appends a huge batch.
    // Autobase still owns atomicity across reorgs: it truncates the view
    // itself, whatever we flushed.
    let view = rawView.batch()
    let pending = 0
    // Edge counters are accumulated here and written once per chunk: 1,000
    // relations into one folder would otherwise rewrite that folder's count
    // 1,000 times, each a block every joining peer has to build and commit.
    this.#counts = new Map()
    const flush = async () => {
      for (const [key, count] of this.#counts) {
        const [layoutId, direction, entityId, type] = JSON.parse(key)
        await layoutFor({ layout: layoutId }).putCount(view, direction, entityId, type, count)
      }
      this.#counts.clear()
      await view.flush()
    }
    try {
      await this.#applyNodes(batch, host, () => view, async () => {
        if (++pending < tuning.INDEX_BATCH) return
        await flush()
        view = rawView.batch()
        pending = 0
      })
      await flush()
    } finally {
      this.#counts = null
      await view.close()
    }

    await this.#drainPendingModeration(rawView)
    await this.#drainPendingWriterChanges(rawView, host)
  }

  async #applyNodes (batch, host, currentView, beforeEvent) {
    let record = null
    for (const { value, from, length, optimistic } of batch) {
      // Count first: this may flush and open a fresh batch, which is then
      // the one every write for this event must go to.
      await beforeEvent()
      const view = currentView()
      // decodeEvent never throws (malformed bytes come back as a
      // decodeError marker) — and a node with no value at all is skipped
      // rather than crashing apply for every peer (Principle I).
      if (!value) continue
      const event = decodeEvent(value)
      if (!event || event.decodeError) continue

      if (event.type === 'context/init') {
        await this.#applyContextInit(view, event, from, host)
        record = null // re-read: it may have just been written
        continue
      }

      if (event.type === 'context/upgrade') {
        await this.#applyContextUpgrade(view, event, from, host)
        record = null
        continue
      }

      // Every peer must apply this context the same way. A version this code
      // doesn't know, or app rules other than the ones the context was
      // created with, stop apply rather than build a different index.
      if (record === null) {
        record = await this.#record(view)
        this.#applyIndex = layoutFor(record)
      }
      const refusal = this.#refusal(record)
      if (refusal) {
        host.interrupt(refusal)
        return
      }

      // From a peer that isn't a writer: only an invite redemption may count.
      if (optimistic) {
        if (event.type === 'context/redeem') await this.#applyContextRedeem(view, event, host, record, from, true)
        continue
      }

      if (event.type === 'context/invite') {
        await this.#applyContextInvite(view, event, record)
        continue
      }

      if (event.type === 'context/redeem') {
        await this.#applyContextRedeem(view, event, host, record, from, false)
        continue
      }

      if (event.type === 'addWriter') {
        if (this.#writeMode !== 'open') continue
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        await host.addWriter(key, { indexer: await this.#addedWriterIndexes(view, host) })
        continue
      }

      if (event.type === 'context/writer') {
        await this.#applyContextWriter(view, event, host, record)
        continue
      }

      if (event.type === 'context/role') {
        await this.#applyContextRole(view, event, host, record)
        continue
      }

      if (record.version === 3 && (event.type === 'roles/addWriter' || event.type === 'roles/removeWriter')) {
        // Version 3: the decision comes from the context's own role table,
        // so every peer decides the same (spec 005). No RoleBase, no queue.
        if (this.#writeMode === 'closed') {
          if (!this.#verifyWriterChangeSignature(event)) continue
          if (!(await this.#can(view, event.author, 'context.write'))) continue
        }
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        if (event.type === 'roles/addWriter') {
          await host.addWriter(key, { indexer: false })
        } else {
          try { host.removeWriter(key) } catch (err) { safetyCatch(err) }
        }
        continue
      }

      if (event.type === 'roles/addWriter') {
        // SECURITY: this is the real, enforced boundary — it runs
        // identically on every peer regardless of how the event got into
        // the log (the "nice" addWriter() method's own check, further
        // down, is a client-side fail-fast convenience only; append()
        // bypasses it entirely, confirmed directly). Only enforced in
        // closed mode: open mode's whole point is that anyone can add
        // anyone, so author-forgery protection has nothing to protect
        // there, and requiring it would break every existing open-mode
        // caller for no security benefit.
        if (this.#writeMode === 'closed') {
          if (!this.#verifyWriterChangeSignature(event)) continue
          const allowed = await this.#isWriterChangeAllowed(event.author)
          if (allowed === null) {
            // RoleBase not yet synced on this peer — defer rather than
            // permanently drop. Confirmed empirically: a peer that hasn't
            // finished syncing its RoleBase by the time this event is
            // first processed would otherwise lose this grant forever,
            // since Autobase doesn't re-run apply for past entries just
            // because unrelated data (the RoleBase) later changes.
            await this.#queuePendingWriterChange(view, event)
            continue
          }
          if (!allowed) continue
        }
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        await host.addWriter(key, { indexer: await this.#addedWriterIndexes(view, host) })
        continue
      }

      if (event.type === 'roles/removeWriter') {
        if (this.#writeMode === 'closed') {
          if (!this.#verifyWriterChangeSignature(event)) continue
          const allowed = await this.#isWriterChangeAllowed(event.author)
          if (allowed === null) {
            await this.#queuePendingWriterChange(view, event)
            continue
          }
          if (!allowed) continue
        }
        const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
        try {
          host.removeWriter(key)
        } catch (err) {
          // host.removeWriter() itself throws if this would remove the
          // last indexer — not a reason to abort the rest of this batch.
          safetyCatch(err)
        }
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

  // How far into the future a moderation event's own claimed timestamp is
  // allowed to be, relative to this peer's clock at the moment it's
  // applied. See the rejection check in #verifyModerationSignature for why
  // this exists — it is not just clock-skew tolerance, it closes a real
  // exploit.
  static #MODERATION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000

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

    // SECURITY: consumers of moderation history (including this library's
    // own reference ForumPolicy, examples/forum/policy/index.js) resolve a
    // conflict between a 'content.hide' and a later 'content.reveal' (or
    // vice versa) on the same target by picking whichever event's
    // `timestamp` is larger — a timestamp is part of the signed payload
    // (see #stableModerationHash), so it's the signer's own honest claim,
    // never independently verified. Without this bound, anyone holding
    // even ONE of those two permissions (by default, content.reveal is
    // admin/owner-only, but content.hide is also granted to plain `mod`)
    // could sign a single event with an arbitrarily large timestamp and
    // make it permanently un-overridable by any real action from anyone —
    // including a more-trusted role — since no genuine future timestamp
    // could ever exceed a forged one. This only needs to bound the future
    // side: an old timestamp just makes an event lose comparisons, which
    // isn't useful to an attacker trying to make their own action stick.
    // Also robust to normal replication delay — this compares against
    // wall-clock time at whatever moment the event is actually applied, not
    // against when it was created, so a peer catching up long after being
    // offline is unaffected; only a timestamp claiming to be from the
    // future relative to whenever it's actually checked is rejected, and
    // real time only moves forward.
    if (event.timestamp > Date.now() + ContextBase.#MODERATION_MAX_FUTURE_SKEW_MS) return false

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

    const digest = stableRelationHash(event, this.key ? this.key.toString('hex') : null)
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

    const digest = stableTagHash(event, this.key ? this.key.toString('hex') : null)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  #verifyWriterChangeSignature (event) {
    if (!event) return false
    if (event.type !== 'roles/addWriter' && event.type !== 'roles/removeWriter') return false
    if (typeof event.key !== 'string' || event.key.length === 0) return false
    if (typeof event.author !== 'string' || event.author.length === 0) return false
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

    const digest = this.#stableWriterChangeHash(event)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  #stableWriterChangeHash (event) {
    const msg = {
      op: event.type,
      key: event.key,
      author: event.author,
      timestamp: event.timestamp
    }
    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  /**
   * Whether event.author has permission to add/remove writers on this
   * context. Mirrors #isModerationAllowed's pattern: returns null (not
   * false) if no RoleBase is attached at all, so open-mode contexts
   * (which don't require one) aren't blocked by this check — closed-mode
   * callers are expected to check for null themselves and treat it as
   * "not authorized", since closed mode requires a RoleBase to be
   * meaningful at all.
   */
  async #isWriterChangeAllowed (authorPubkeyHex) {
    if (!this.#roleBase || typeof this.#roleBase.getRegistry !== 'function' || typeof this.#roleBase.can !== 'function') {
      return null
    }

    // Bounded retry: the RoleBase and this context are two independent
    // Autobase structures that replicate concurrently — the RoleBase data
    // for a given author may simply not have arrived yet at the moment
    // this specific event is first processed. Apply only runs when new
    // data arrives for THIS context's own log, so if nothing else is ever
    // appended here, a single immediate "not ready" would leave this
    // pending forever with no way to re-check (confirmed empirically).
    // Polling here for a few seconds covers the common case; the pending-
    // queue fallback in the caller remains as a last resort if the
    // RoleBase genuinely never arrives within this window.
    let registry = null
    for (let i = 0; i < 40; i++) {
      try {
        registry = await this.#roleBase.getRegistry()
      } catch {
        registry = null
      }
      if (registry) break
      await sleep(250)
    }

    if (!registry) return null

    try {
      return await this.#roleBase.can(authorPubkeyHex, 'context.write')
    } catch {
      return false
    }
  }

  async #queuePendingWriterChange (view, event) {
    const key = `w:p:${event.type}:${event.key}:${event.timestamp}`
    await view.put(key, { event })
  }

  async #drainPendingWriterChanges (view, host) {
    // If registry isn't ready yet, keep pending items — mirrors
    // #drainPendingModeration's own guard.
    if (!this.#roleBase || typeof this.#roleBase.getRegistry !== 'function') return

    let registry = null
    try {
      registry = await this.#roleBase.getRegistry()
    } catch {
      registry = null
    }
    if (!registry) return

    const stream = view.createReadStream({ gte: 'w:p:', lt: 'w:p:' + '\uffff' })
    for await (const entry of stream) {
      const v = entry.value
      if (!v || !v.event || typeof v.event !== 'object') {
        await view.del(entry.key)
        continue
      }

      const event = v.event
      const allowed = await this.#isWriterChangeAllowed(event.author)
      if (allowed === null) continue // still not ready, leave queued

      await view.del(entry.key)
      if (!allowed) continue // now resolved: explicitly denied

      const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
      if (event.type === 'roles/addWriter') {
        await host.addWriter(key, { indexer: await this.#addedWriterIndexes(view, host) })
      } else if (event.type === 'roles/removeWriter') {
        try {
          host.removeWriter(key)
        } catch (err) {
          safetyCatch(err)
        }
      }
    }
  }

  async #applyModerationAction (view, event, from, length) {
    // Ingestion rules (deterministic): verify signature + validate schema or skip.
    if (!this.#verifyModerationSignature(event)) return

    // Version 3: decided from the context's own role table (spec 005).
    if ((await this.#record(view)).version === 3) {
      if (!(await this.#can(view, event.author, event.action))) return
      const coreKeyHex = from && from.key ? from.key.toString('hex') : ''
      const seq = typeof length === 'number' && length > 0 ? length - 1 : -1
      const eventId = crypto.createHash('sha256').update(`${coreKeyHex}:${seq}`).digest('hex')
      await this.#indexModerationEvent(view, event, { eventId, coreKeyHex, seq })
      return
    }

    const coreKeyHex = from && from.key ? from.key.toString('hex') : ''
    const seq = typeof length === 'number' && length > 0 ? length - 1 : -1
    const eventId = crypto.createHash('sha256').update(`${coreKeyHex}:${seq}`).digest('hex')

    const allowed = await this.#isModerationAllowed(event)
    if (allowed === null) {
      this.#moderationQueued = true
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

    // One look, no waiting. The RoleBase and this context replicate
    // independently, so the registry may not have arrived yet; then the
    // caller queues the event and the next update() decides it. This used
    // to retry for up to 10 s inside apply, which stalled the whole context
    // on every peer (moderation.js spent 10.5 s per event with no RoleBase).
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

  // The context's own record of how it is applied (spec 003, data-model.md).
  // Honoured only from the bootstrap writer — the context's creator — and only
  // once, so no other writer can change how every peer applies the context.
  async #applyContextInit (view, event, from, host) {
    if (!this.#fromBootstrap(from)) return
    if (await view.get(CONTEXT_RECORD_KEY)) return
    const record = { version: event.version, rules: event.rules || '' }
    if (typeof event.owner === 'string' && event.owner.length > 0) record.owner = event.owner
    // The index layout is fixed here, for the context's whole life: every
    // peer must build the same view (spec 002). No layout means 1.
    if (typeof event.layout === 'number' && event.layout !== 1) record.layout = event.layout
    await view.put(CONTEXT_RECORD_KEY, record)
    const refusal = this.#refusal(record)
    if (refusal) {
      host.interrupt(refusal)
      return
    }
    if (record.version === 3 && record.owner) await this.#startRoleTable(view, record.owner, from.key)
  }

  // Whether a node comes from the context's bootstrap writer (its creator).
  #fromBootstrap (from) {
    return !!(from && from.key && this.#base.key && from.key.equals(this.#base.key))
  }

  // A version 3 context's starting role table: the creator is owner, and
  // the creator's own writer (the bootstrap writer) is linked to it.
  async #startRoleTable (view, owner, bootstrapKey) {
    await view.put(ROLES_KEY, defaultRoleTable(owner))
    await this.#linkWriter(view, b4a.toString(bootstrapKey, 'hex'), owner)
  }

  async #linkWriter (view, writerHex, member) {
    await view.put(`w:m:${writerHex}`, { member })
    await view.put(`w:k:${member}:${writerHex}`, {})
  }

  async #roleTable (view) {
    const entry = await view.get(ROLES_KEY)
    return entry && entry.value ? entry.value : null
  }

  async #can (view, pubkeyHex, action) {
    return rolesRegistry.can(await this.#roleTable(view), pubkeyHex, action)
  }

  // Whether `author` may set `member`'s role to `role` ('' removes it), per
  // the context's own table at this point of its history (spec 005, R3).
  #mayAssign (table, author, member, role) {
    if (!table) return false
    const current = table.members[member] || null
    if (rolesRegistry.can(table, author, '*')) {
      // An owner may do anything except give up its own ownership: that could
      // leave the context with nobody able to manage it.
      return !(member === author && current === 'owner' && role !== 'owner')
    }
    const minor = (r) => r === 'mod' || r === 'member'
    if (role === '') return (current === null || minor(current)) && rolesRegistry.can(table, author, 'mod.remove')
    return minor(role) && (current === null || minor(current)) && rolesRegistry.can(table, author, 'mod.add')
  }

  #verifyContextSignature (event) {
    if (typeof event.author !== 'string' || event.author.length === 0) return false
    if (typeof event.signature !== 'string' || event.signature.length === 0) return false
    try {
      return hypercoreCrypto.verify(
        stableContextHash(event, this.key ? this.key.toString('hex') : null),
        b4a.from(event.signature, 'hex'),
        b4a.from(event.author, 'hex')
      )
    } catch {
      return false
    }
  }

  // context/writer (spec 005): add a writer, linked to the member it belongs
  // to; it indexes iff that member's role allows it.
  async #applyContextWriter (view, event, host, record) {
    if (record.version !== 3) return
    if (typeof event.key !== 'string' || event.key.length === 0) return
    if (!this.#verifyContextSignature(event)) return
    if (this.#writeMode === 'closed' && !(await this.#can(view, event.author, 'context.write'))) return
    const member = event.member || ''
    if (member) await this.#linkWriter(view, event.key, member)
    const indexer = member ? await this.#can(view, member, 'context.index') : false
    await host.addWriter(b4a.from(event.key, 'hex'), { indexer })
  }

  // context/role (spec 005): change a member's role, then promote or demote
  // the member's writers to match. All or nothing: if that would demote the
  // last indexer, nothing changes.
  async #applyContextRole (view, event, host, record) {
    if (record.version !== 3) return
    if (typeof event.member !== 'string' || event.member.length === 0) return
    if (!this.#verifyContextSignature(event)) return
    const table = await this.#roleTable(view)
    const role = event.role || ''
    if (!this.#mayAssign(table, event.author, event.member, role)) return

    let next
    try {
      next = rolesRegistry.applyRoleEvent(table, role
        ? { type: 'roles/setRole', member: event.member, role }
        : { type: 'roles/removeMember', member: event.member })
    } catch (err) {
      safetyCatch(err)
      return
    }

    const before = rolesRegistry.can(table, event.member, 'context.index')
    const after = rolesRegistry.can(next, event.member, 'context.index')
    const writers = before === after ? [] : await this.#writersOf(view, event.member)
    if (before && !after) {
      for (const key of writers) if (!host.removeable(key)) return
    }

    await view.put(ROLES_KEY, next)
    for (const key of writers) await host.addWriter(key, { indexer: after })
  }

  // context/invite (spec 006): mint (uses > 0) or revoke (uses === 0) an
  // invite. Minting needs the right to grant its role to a new member at
  // this point of the context's history; revoking, being its minter or
  // having that same right.
  async #applyContextInvite (view, event, record) {
    if (record.version !== 3) return
    if (typeof event.inviteKey !== 'string' || event.inviteKey.length !== 64) return
    if (!this.#verifyContextSignature(event)) return
    const table = await this.#roleTable(view)
    const key = `inv:${event.inviteKey}`
    const existing = await view.get(key)

    if (event.uses === 0) {
      if (!existing) return
      const inv = existing.value
      if (inv.author !== event.author && !this.#mayAssign(table, event.author, '', inv.role)) return
      await view.put(key, { ...inv, revoked: true })
      return
    }

    if (existing) return // an invite key is minted once
    const role = event.role || 'member'
    if (role === 'owner') return // ownership is never handed out by link
    if (!this.#mayAssign(table, event.author, '', role)) return
    const inv = { role, uses: event.uses, used: 0, revoked: false, author: event.author }
    // A scope request (spec 006 US3) is only recorded here. Whether the
    // minter could hand out that scope is not something this log can know:
    // a key holder checks it against the ScopeBase before granting.
    if (typeof event.scope === 'string' && event.scope.length > 0) {
      if (!HEX64.test(event.scopeBase || '') || !HEX64.test(event.roleBase || '')) return
      Object.assign(inv, { scope: event.scope, scopeBase: event.scopeBase, roleBase: event.roleBase })
    }
    await view.put(key, inv)
  }

  // context/redeem (spec 006): proof of an invite's secret (signed with the
  // invite key) by a member (countersigned), for the writer that appended
  // it. Counts a use, gives the member the invite's role unless they already
  // have one (an invite never lowers a role), and makes the writer a writer —
  // acknowledging it first if it wasn't one yet.
  async #applyContextRedeem (view, event, host, record, from, optimistic) {
    if (record.version !== 3) return
    if (!from || !from.key || event.key !== b4a.toString(from.key, 'hex')) return
    if (typeof event.member !== 'string' || event.member.length === 0) return
    const key = `inv:${event.inviteKey}`
    const entry = await view.get(key)
    if (!entry || !entry.value) return
    const inv = entry.value
    if (inv.revoked || inv.used >= inv.uses) return

    const contextKeyHex = this.key ? this.key.toString('hex') : null
    const digest = stableContextHash(event, contextKeyHex)
    try {
      if (!hypercoreCrypto.verify(digest, b4a.from(event.signature, 'hex'), b4a.from(event.inviteKey, 'hex'))) return
      if (!hypercoreCrypto.verify(digest, b4a.from(event.memberSignature, 'hex'), b4a.from(event.member, 'hex'))) return
    } catch {
      return
    }

    await view.put(key, { ...inv, used: inv.used + 1 })
    let table = await this.#roleTable(view)
    if (!table.members[event.member]) {
      table = rolesRegistry.applyRoleEvent(table, { type: 'roles/setRole', member: event.member, role: inv.role })
      await view.put(ROLES_KEY, table)
    }
    await this.#linkWriter(view, event.key, event.member)
    // The invite asked for a scope: leave a request for a key holder, with
    // the encryption key the member signed (spec 006 US3).
    if (inv.scope && HEX64.test(event.encryptionKey || '')) {
      await view.put(`sg:${event.member}:${inv.scope}`, {
        scope: inv.scope,
        scopeBase: inv.scopeBase,
        roleBase: inv.roleBase,
        member: event.member,
        encryptionKey: event.encryptionKey,
        minter: inv.author
      })
    }
    if (optimistic) await host.ackWriter(from.key)
    await host.addWriter(from.key, { indexer: rolesRegistry.can(table, event.member, 'context.index') })
  }

  async #writersOf (view, member) {
    const prefix = `w:k:${member}:`
    const keys = []
    for await (const entry of view.createReadStream({ gte: prefix, lt: prefix + '\uffff' })) {
      keys.push(b4a.from(entry.key.slice(prefix.length), 'hex'))
    }
    return keys
  }

  // context/upgrade (spec 005): the creator converts a version 1 or 2
  // context to version 3. From here on the context has its own role table;
  // every indexer except the creator's writer stops indexing (they keep
  // writing).
  async #applyContextUpgrade (view, event, from, host) {
    if (!this.#fromBootstrap(from)) return
    if (event.version !== 3 || typeof event.owner !== 'string' || event.owner.length === 0) return
    const current = await this.#record(view)
    if (current.version !== 1 && current.version !== 2) return
    // The layout stays: the entries already written use it.
    await view.put(CONTEXT_RECORD_KEY, { version: 3, rules: current.rules || '', owner: event.owner, ...(current.layout ? { layout: current.layout } : {}) })
    await this.#startRoleTable(view, event.owner, from.key)
    const system = this.#base.system
    const indexers = system && Array.isArray(system.indexers) ? system.indexers.map(w => w.key) : []
    for (const key of indexers) {
      if (b4a.equals(key, from.key)) continue
      await host.addWriter(key, { indexer: false })
    }
  }

  // Why this peer must not apply a context with this record, or null.
  #refusal (record) {
    if (!KNOWN_VERSIONS.includes(record.version)) return `unsupported context version ${record.version}`
    if (!KNOWN_LAYOUTS.includes(record.layout || 1)) return `unsupported index layout ${record.layout}`
    const mine = this.#rules ? this.#rules.id : ''
    if (record.rules !== mine) {
      return `Context rules mismatch: context uses "${record.rules}", this peer provides "${mine}"`
    }
    return null
  }

  /**
   * Run the app's rules on an app data event. Called after the built-in
   * checks passed, before anything is written. Only a literal `true`
   * accepts; a throw, a rejection or any other value rejects — a broken rule
   * must never crash apply (spec 003, FR-015).
   */
  async #passesRules (view, event) {
    if (!this.#rules) return true
    try {
      return (await this.#rules.validate(event, this.#reader(view))) === true
    } catch (err) {
      safetyCatch(err)
      return false
    }
  }

  // Read-only, layout-independent access to the index as it stands inside
  // the current apply chunk (so a rule sees earlier events of the same
  // batch), for app rules. Contract: specs/003-fast-forward-contexts/contracts/api.md
  #reader (view) {
    const index = this.#applyIndex || layoutFor(null)
    const counts = this.#counts
    const count = async (direction, entityId, type) => {
      const key = JSON.stringify([index.id, direction, entityId, type])
      if (counts && counts.has(key)) return counts.get(key)
      return index.getCount(view, direction, entityId, type)
    }
    const edgeRecord = (value) => ({
      from: value.from,
      to: value.to,
      type: value.type,
      author: value.author,
      createdAt: value.createdAt,
      ...(typeof value.value === 'number' ? { value: value.value } : {}),
      ...(typeof value.data === 'string' ? { data: value.data } : {})
    })
    return Object.freeze({
      async hasEdge (from, type, to) {
        const edge = await index.activeEdge(view, from, type, to)
        return !!(edge && !edge.deleted)
      },
      async edges (entityId, opts = {}) {
        const direction = opts.direction === 'in' ? 'in' : 'out'
        const limit = typeof opts.limit === 'number' ? opts.limit : Infinity
        const out = []
        for await (const edge of index.edges(view, entityId, { direction, type: opts.type })) {
          if (out.length >= limit) break
          if (edge.deleted) continue
          out.push(edgeRecord(edge))
        }
        return out
      },
      countIn: (entityId, type) => count('in', entityId, type),
      countOut: (entityId, type) => count('out', entityId, type),
      hasTag: (entityId, tag) => index.hasTag(view, entityId, tag)
    })
  }

  /**
   * The context's topology record. Contexts created before spec 003 have
   * none and are version 1.
   *
   * @returns {Promise<{ version: number, rules: string }>}
   */
  async #record (view = this.#base.view) {
    const entry = view ? await view.get(CONTEXT_RECORD_KEY) : null
    return entry && entry.value ? entry.value : { version: 1, rules: '' }
  }

  /**
   * Why this peer can't apply this context, if that is already known locally:
   * it was interrupted, or the context's record is held locally and refuses
   * this peer's rules or version. Never waits on the network — a fresh peer
   * that hasn't received the record yet finds out when it applies.
   *
   * @returns {Promise<string|null>}
   */
  async refusal () {
    if (!this.opened) await this.ready()
    if (this.#interrupted) return this.#interrupted
    const view = this.#base.view
    if (!view || !view.core || view.core.length === 0) return null
    let entry = null
    try {
      entry = await view.get(CONTEXT_RECORD_KEY, { wait: false })
    } catch {
      return null
    }
    return entry && entry.value ? this.#refusal(entry.value) : null
  }

  // Whether a writer added now indexes. Decided from the context's own record,
  // so every peer decides the same: version 1 contexts (before spec 003) make
  // every writer an indexer; version 2 keeps the creator as the only one.
  async #addedWriterIndexes (view, host) {
    const { version } = await this.#record(view)
    if (version === 1) return true
    // Version 2: only the creator indexes. Version 3: a writer added this way
    // has no member link, so no role that could make it index (spec 005).
    if (version === 2 || version === 3) return false
    host.interrupt(`unsupported context version ${version}`)
    return false
  }

  // Refresh the full member list writerKeys() reports. Reads the system's
  // member table, which Autobase says is not safe during apply — so only
  // ever called from update(), outside it.
  async #refreshMembers () {
    const system = this.#base && this.#base.system
    if (!system || typeof system.list !== 'function') return
    // Cleared before reading: a change applied meanwhile sets it again.
    this.#membersDirty = false
    this.#membersCount = system.members
    const members = []
    try {
      for await (const { key, value } of system.list()) {
        if (value && value.isRemoved) continue
        members.push(b4a.toString(key, 'hex'))
      }
    } catch (err) {
      safetyCatch(err)
      this.#membersDirty = true
      return
    }
    this.#members = members
  }

  // The hex public key of a signing key pair, or a clear error.
  #signer (keyPair, what) {
    if (!keyPair || !keyPair.publicKey || !keyPair.secretKey) {
      throw new Error(`opts.keyPair (with publicKey and secretKey) is required to sign ${what}`)
    }
    return b4a.isBuffer(keyPair.publicKey) ? keyPair.publicKey.toString('hex') : String(keyPair.publicKey)
  }

  #signContext (event, keyPair) {
    event.signature = hypercoreCrypto.sign(stableContextHash(event, this.key ? this.key.toString('hex') : null), keyPair.secretKey).toString('hex')
    return event
  }

  /**
   * This context's own role table (version 3 contexts, spec 005):
   * `{ roles: { role: permissions[] }, members: { pubkeyHex: role } }`.
   * Empty for older contexts, whose roles live in the RoleBase.
   *
   * @returns {Promise<{ roles: Object, members: Object }>}
   */
  async roles () {
    if (!this.opened) await this.ready()
    const table = this.#base.view ? await this.#roleTable(this.#base.view) : null
    return table ? { roles: table.roles, members: table.members } : { roles: {}, members: {} }
  }

  /**
   * Give `member` a role in this context (version 3). Takes effect only if
   * the signer may grant it at that point of the context's history: the
   * owner any role; holders of `mod.add` the `mod` and `member` roles. A
   * member's writers index iff the new role allows it.
   *
   * @param {string} member - Device public key (hex)
   * @param {string} role
   * @param {{ keyPair: { publicKey: Buffer, secretKey: Buffer } }} opts
   */
  async setRole (member, role, opts = {}) {
    if (!this.opened) await this.ready()
    if (typeof role !== 'string' || role.length === 0) throw new Error('role is required')
    await this.#appendRole(member, role, opts)
  }

  /**
   * Remove `member`'s role in this context (version 3).
   *
   * @param {string} member
   * @param {{ keyPair: { publicKey: Buffer, secretKey: Buffer } }} opts
   */
  async removeRole (member, opts = {}) {
    if (!this.opened) await this.ready()
    await this.#appendRole(member, '', opts)
  }

  async #appendRole (member, role, opts) {
    if (typeof member !== 'string' || member.length === 0) throw new Error('member is required')
    if ((await this.#record()).version !== 3) throw new Error('This context has no role table of its own (version 3 only; see upgrade())')
    const author = this.#signer(opts.keyPair, 'a role change')
    await this.append(this.#signContext({ type: 'context/role', member, role, author, timestamp: Date.now(), signature: null }, opts.keyPair))
  }

  /**
   * Convert a version 1 or 2 context to version 3 (spec 005). Only takes
   * effect when appended by the context's creator (its bootstrap writer);
   * `opts.keyPair` names the owner of the new role table.
   *
   * @param {{ keyPair: { publicKey: Buffer } }} opts
   */
  async upgrade (opts = {}) {
    if (!this.opened) await this.ready()
    if (!opts.keyPair || !opts.keyPair.publicKey) throw new Error('opts.keyPair is required')
    const owner = b4a.isBuffer(opts.keyPair.publicKey) ? opts.keyPair.publicKey.toString('hex') : String(opts.keyPair.publicKey)
    await this.append({ type: 'context/upgrade', version: 3, owner, timestamp: Date.now() })
  }

  /**
   * Mint an invite link granting `role` in this context (version 3, spec 006).
   * Whoever holds the link can redeem it up to `uses` times, becoming a writer
   * with that role, without anyone acting at that moment. Takes effect only
   * if the signer may grant `role` (see setRole()); `owner` can't be invited.
   *
   * With `scope`, the invite also asks for read access to that scope of the
   * graph's ScopeBase: once redeemed, a member who holds the scope's key
   * seals it to the redeemer on their next `graph.update()` (spec 006 US3).
   * Needs the minter to hold the scope's current key and `scope.grant`.
   *
   * @param {{ role?: string, uses?: number, scope?: string, keyPair: Object }} opts
   * @returns {Promise<string>} `hypergraph://invite/<contextKeyHex>/<secretHex>`
   */
  async createInvite (opts = {}) {
    if (!this.opened) await this.ready()
    if ((await this.#record()).version !== 3) throw new Error('Invites need a context with its own role table (version 3; see upgrade())')
    const role = opts.role || 'member'
    if (role === 'owner') throw new Error('Ownership cannot be handed out by invite')
    const uses = opts.uses === undefined ? 1 : opts.uses
    if (!Number.isInteger(uses) || uses < 1) throw new Error('opts.uses must be a positive integer')
    const author = this.#signer(opts.keyPair, 'an invite')
    const event = { type: 'context/invite', inviteKey: null, role, uses, author, timestamp: Date.now(), signature: null }
    if (opts.scope !== undefined) {
      // Ask for read access too (spec 006 US3). A key holder grants it only
      // if the minter could have granted it themselves, so check that here.
      if (typeof opts.scope !== 'string' || opts.scope.length === 0) throw new Error('opts.scope must be a scope id')
      const keys = this.#scopes ? this.#scopes.keys() : {}
      if (!keys.scopeBase || !keys.roleBase) throw new Error('A scoped invite needs this graph\'s ScopeBase and RoleBase attached')
      if (!(await this.#scopes.entitled(opts.scope, author))) throw new Error('You do not hold the current key for this scope, or may not grant it')
      Object.assign(event, { scope: opts.scope, scopeBase: keys.scopeBase, roleBase: keys.roleBase })
    }
    const seed = hypercoreCrypto.randomBytes(32)
    event.inviteKey = b4a.toString(hypercoreCrypto.keyPair(seed).publicKey, 'hex')
    await this.append(this.#signContext(event, opts.keyPair))
    return `hypergraph://invite/${this.key.toString('hex')}/${b4a.toString(seed, 'hex')}`
  }

  /**
   * Revoke an invite: no further redemptions are accepted.
   *
   * @param {string} linkOrInviteKey - The link, or the invite's public key (hex)
   * @param {{ keyPair: Object }} opts
   */
  async revokeInvite (linkOrInviteKey, opts = {}) {
    if (!this.opened) await this.ready()
    const inviteKey = linkOrInviteKey.startsWith('hypergraph://')
      ? parseInviteLink(linkOrInviteKey).inviteKey
      : linkOrInviteKey
    const author = this.#signer(opts.keyPair, 'an invite revocation')
    const entry = this.#base.view ? await this.#base.view.get(`inv:${inviteKey}`) : null
    const role = entry && entry.value ? entry.value.role : ''
    await this.append(this.#signContext({ type: 'context/invite', inviteKey, role, uses: 0, author, timestamp: Date.now(), signature: null }, opts.keyPair))
  }

  /**
   * Invites recorded in this context: `{ inviteKeyHex: { role, uses, used, revoked, author, scope?, scopeBase?, roleBase? } }`.
   */
  /**
   * An invite and a member's role as the indexers have confirmed them: read
   * from the view at its signed length, so nothing that could still be
   * reordered counts. (Not `base.signedLength`: with several indexers the
   * last acks are never confirmed, so "confirmed up to length L" may never
   * become true; acks write nothing to the view.)
   *
   * @returns {Promise<{ invite: Object|null, role: string|null }>}
   */
  async confirmedInvite (inviteKey, member) {
    if (!this.opened) await this.ready()
    const view = this.#base.view
    if (!view || !view.core || view.core.signedLength === 0) return { invite: null, role: null }
    const snap = view.checkout(view.core.signedLength)
    try {
      const inv = await snap.get(`inv:${inviteKey}`)
      const roles = await snap.get(ROLES_KEY)
      const role = roles && roles.value && roles.value.members ? roles.value.members[member] || null : null
      return { invite: inv ? inv.value : null, role }
    } finally {
      await snap.close()
    }
  }

  /**
   * Scope keys asked for by redeemed invites: `[{ scope, scopeBase, roleBase,
   * member, encryptionKey, minter }]`. graph.update() grants them when it can.
   *
   * @returns {Promise<Object[]>}
   */
  async scopeRequests () {
    if (!this.opened) await this.ready()
    const out = []
    const view = this.#base.view
    if (!view) return out
    for await (const entry of view.createReadStream({ gte: 'sg:', lt: 'sg:\uffff' })) out.push(entry.value)
    return out
  }

  async invites () {
    if (!this.opened) await this.ready()
    const out = {}
    const view = this.#base.view
    if (!view) return out
    for await (const entry of view.createReadStream({ gte: 'inv:', lt: 'inv:\uffff' })) out[entry.key.slice(4)] = entry.value
    return out
  }

  /**
   * Redeem an invite as this device: append the redemption, as a non-writer
   * if need be. Used by graph.redeemInvite(), which also waits for the result.
   *
   * @param {string} link
   * @param {{ publicKey: Buffer, secretKey: Buffer }} memberKeyPair
   * @param {Buffer} [encryptionPublicKey] - Where a scope the invite asks
   *   for gets sealed to; signed along with the rest.
   */
  async redeem (link, memberKeyPair, encryptionPublicKey) {
    if (!this.opened) await this.ready()
    const { seed, inviteKey } = parseInviteLink(link)
    const invite = hypercoreCrypto.keyPair(b4a.from(seed, 'hex'))
    const event = {
      type: 'context/redeem',
      inviteKey,
      member: b4a.toString(memberKeyPair.publicKey, 'hex'),
      key: this.localKey.toString('hex'),
      timestamp: Date.now(),
      signature: null,
      memberSignature: null
    }
    if (encryptionPublicKey) event.encryptionKey = b4a.toString(encryptionPublicKey, 'hex')
    const digest = stableContextHash(event, this.key.toString('hex'))
    event.signature = b4a.toString(hypercoreCrypto.sign(digest, invite.secretKey), 'hex')
    event.memberSignature = b4a.toString(hypercoreCrypto.sign(digest, memberKeyPair.secretKey), 'hex')
    await this.#base.append(encodeEvent(event), this.#base.writable ? undefined : { optimistic: true })
  }

  /**
   * Whether `pubkeyHex` may perform `action` in this context, if this
   * context decides that itself (version 3); null when its roles live in
   * the RoleBase.
   *
   * @returns {Promise<boolean|null>}
   */
  async allows (pubkeyHex, action) {
    if (!this.opened) await this.ready()
    if ((await this.#record()).version !== 3) return null
    return this.#can(this.#base.view, pubkeyHex, action)
  }

  /**
   * Where this context stands: its topology, this peer's role in it, and how
   * much of its history is confirmed (signed by the indexers, so it can no
   * longer be reordered).
   *
   * @returns {Promise<{ version: number, rules: string, indexers: string[], fastForwards: number, interrupted: string|null, isIndexer: boolean, writable: boolean, length: number, confirmedLength: number }>}
   */
  async status () {
    if (!this.opened) await this.ready()
    const record = this.#interrupted ? { version: null, rules: null } : await this.#record()
    const { version, rules } = record
    // The indexer set as the system knows it right now. A writer's own
    // isIndexer flag only flips once that change is itself confirmed.
    const system = this.#base.system
    const indexers = system && Array.isArray(system.indexers)
      ? system.indexers.map(w => b4a.toString(w.key, 'hex'))
      : []
    return {
      version,
      rules,
      layout: record.version === null ? null : (record.layout || 1),
      indexers,
      isIndexer: !!this.#base.isIndexer,
      writable: !!this.#base.writable,
      length: this.#base.length,
      confirmedLength: this.#base.signedLength,
      fastForwards: this.#fastForwards,
      interrupted: this.#interrupted
    }
  }

  async #applyRelation (view, event) {
    // Verify signature before applying (if enabled)
    if (this.#verifySignatures && !this.#verifyRelationSignature(event)) return

    // SECURITY: relate() cannot cheaply check that its caller actually owns
    // `from` (legitimately, `from` is very often someone ELSE's entity —
    // a reply, a vote). So a validly-signed relation event claiming
    // `from: <an entity the signer doesn't own>` is not a forged
    // signature, just an honest lie about provenance — and it runs
    // identically on every peer regardless of how the event reached the
    // log, the same enforcement model as roles/addWriter above. Rejected
    // here (not just filtered at getEdges() read time in view.js) so the
    // cnt:in/cnt:out counters — which getEdges()'s own defensive filter
    // cannot reach, since countEdgesIn/Out() read those counters directly
    // rather than iterating and re-checking every edge — never count a
    // spoofed edge in the first place.
    if (authorFromEntityId(event.from) !== event.author) return
    if (relationDataProblem(event.data)) return
    if (!(await this.#passesRules(view, event))) return

    const index = this.#applyIndex
    const existing = await index.activeEdge(view, event.from, event.relationType, event.to)
    if (existing && !existing.deleted) return

    // The edge, its active-edge ref and its incoming entry.
    await index.addEdge(view, {
      from: event.from,
      to: event.to,
      type: event.relationType,
      author: event.author,
      createdAt: event.timestamp,
      value: event.value,
      data: event.data
    })

    // In P2P delivery, a delete event may arrive before its create. The count is clamped at 0 on delete,
    // but will not self-correct when the create arrives later. Counts may read one low on recently-synced peers.
    await this.#bumpCount(view, 'in', event.to, event.relationType, 1)
    await this.#bumpCount(view, 'out', event.from, event.relationType, 1)
  }

  // Add `delta` to an edge counter, clamped at 0. Written at the end of the
  // apply chunk (see #applyView), so repeated bumps cost one block.
  async #bumpCount (view, direction, entityId, type, delta) {
    const index = this.#applyIndex
    const key = JSON.stringify([index.id, direction, entityId, type])
    let count = this.#counts.get(key)
    if (count === undefined) count = await index.getCount(view, direction, entityId, type)
    this.#counts.set(key, Math.max(0, count + delta))
  }

  async #applyRelationDelete (view, event) {
    // Verify signature before applying (if enabled)
    if (this.#verifySignatures && !this.#verifyRelationSignature(event)) return
    if (!(await this.#passesRules(view, event))) return

    // NOTE: deliberately no from-ownership check here, unlike
    // #applyRelation above. unrelate() is intentionally permissive — any
    // authorized writer can remove a relation, not just whoever originally
    // created it (see "unrelate by a different writer" in
    // test/brittle/core/relations.js). Creating a relation asserts a new
    // claim of origin, which is what needs the from-ownership check;
    // removing one doesn't fabricate anything.

    // Marks the edge deleted, drops its incoming entry and active-edge ref.
    await this.#applyIndex.removeEdge(view, event.from, event.relationType, event.createdAt, event.to)

    await this.#bumpCount(view, 'in', event.to, event.relationType, -1)
    await this.#bumpCount(view, 'out', event.from, event.relationType, -1)
  }

  async #applyTag (view, event) {
    // Verify signature before applying
    if (!this.#verifyTagSignature(event)) return
    if (!(await this.#passesRules(view, event))) return

    await this.#applyIndex.addTag(view, {
      entityId: event.entityId,
      tag: event.tag,
      author: event.author,
      createdAt: event.timestamp
    })
  }

  async #applyTagDelete (view, event) {
    // Verify signature before applying
    if (!this.#verifyTagSignature(event)) return
    if (!(await this.#passesRules(view, event))) return

    await this.#applyIndex.removeTag(view, event.tag, event.entityId, event.author)
  }

  async #applyMessage (view, event) {
    if (!(await this.#passesRules(view, event))) return
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

  /** @returns {Object|undefined} The underlying Autobase instance */
  get base () {
    return this.#base
  }

  /** @returns {boolean} Whether the context is writable */
  get writable () {
    return this.#base ? this.#base.writable : false
  }

  /** @returns {Object|undefined} The underlying Autobase core */
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

  /** @returns {Object|undefined} The materialized view Hyperbee */
  get view () {
    return this.#base?.view
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

    // Every member the system lists, as of the last update(): Autobase's
    // activeWriters below only includes a non-indexing writer once it has
    // written something, and version 2 contexts make most writers
    // non-indexers (spec 003).
    const keys = [...this.#members]

    try {
      // Autobase (7.x) has no `inputs`/`writers` array — the live writer set
      // is `activeWriters`, an iterable of Writer instances, each wrapping
      // its own core at `.core`.
      for (const w of base.activeWriters) {
        if (w && w.core && w.core.key) keys.push(w.core.key.toString('hex'))
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
    
    if (this.#interrupted) throw new Error(this.#interrupted)
    try {
      await this.#base.append(encodeEvent(event), opts)
    } catch (err) {
      // If this append is what made the context stop (its own record refused
      // this peer), say why rather than Autobase's generic "closing".
      if (this.#interrupted) throw new Error(this.#interrupted)
      throw err
    }
    await this.#base.update()
    return { length: this.#base.length }
  }

  /**
   * Append many events as ONE Autobase batch.
   *
   * Every peer replays a context one writer batch at a time — each with its
   * own apply call and system flush — so grouping a bulk write here is what
   * keeps it cheap for every future member, not just for this writer (see
   * specs/002-scale-indexing/research.md R2).
   *
   * The `optimistic` flag `append()` uses in open mode is left off here:
   * with an array, Autobase splits the batch around the optimistic block and
   * hands apply nodes with no value (research R3). A peer that is not yet a
   * writer falls back to one `append()` per event, which is exactly what it
   * would have done without this method.
   *
   * @param {Object[]} events
   * @returns {Promise<{length: number}>} The length of the base after append
   */
  async appendBatch (events) {
    if (!this.opened) await this.ready()
    if (events.length === 0) return { length: this.#base.length }

    // Encode everything first, so a bad event throws before anything is written.
    const encoded = events.map(encodeEvent)

    if (!this.#base.writable) {
      for (const event of events) await this.append(event)
      return { length: this.#base.length }
    }

    if (this.#interrupted) throw new Error(this.#interrupted)
    try {
      await this.#base.append(encoded)
      await this.#base.update()
    } catch (err) {
      if (this.#interrupted) throw new Error(this.#interrupted)
      throw err
    }
    return { length: this.#base.length }
  }

  /**
   * Add a writer to the context.
   *
   * In 'open' mode, any writer can be added; no keyPair/signature is
   * needed, since there's no permission check for a forged author to
   * threaten. In 'closed' mode, requires the 'context.write' privilege
   * from the attached RoleBase, and the event is cryptographically signed
   * with opts.keyPair and verified again at the apply layer (the real,
   * enforced security boundary — this method's own check is a
   * client-side fail-fast convenience, since a caller could otherwise
   * bypass it entirely via the generic append() method).
   *
   * @param {Buffer|string} coreKey - The writer's core key (hex string or Buffer)
   * @param {Object} [opts] - Options object
   * @param {Object} [opts.keyPair] - Required in closed mode: { publicKey, secretKey } to sign the event
   * @returns {Promise<void>}
   * @throws {Error} If keyPair is missing in closed mode, RoleBase is required but not attached, or authorization fails
   */
  async addWriter (coreKey, opts = {}) {
    if (!this.opened) await this.ready()

    const key = Buffer.isBuffer(coreKey) ? coreKey : Buffer.from(coreKey, 'hex')
    const keyHex = key.toString('hex')

    // Version 3 (spec 005): a signed context/writer, linked to its member so
    // the member's role decides whether it indexes. Without a keyPair (open
    // mode only) it falls through to the unsigned event: a non-indexing
    // writer with no member link.
    const { version } = await this.#record()
    if (version === 3 && (opts.keyPair || this.#writeMode === 'closed')) {
      const author = this.#signer(opts.keyPair, 'addWriter')
      if (this.#writeMode === 'closed' && !(await this.#can(this.#base.view, author, 'context.write'))) {
        throw new Error('Not authorized to add writers to this context')
      }
      await this.append(this.#signContext({ type: 'context/writer', key: keyHex, member: opts.member || '', author, timestamp: Date.now(), signature: null }, opts.keyPair))
      return
    }

    if (this.#writeMode !== 'closed') {
      await this.append({ type: 'roles/addWriter', key: keyHex })
      return
    }

    if (!opts.keyPair || !opts.keyPair.publicKey || !opts.keyPair.secretKey) {
      throw new Error('opts.keyPair (with publicKey and secretKey) is required in closed mode to sign the addWriter event')
    }
    const author = b4a.isBuffer(opts.keyPair.publicKey) ? opts.keyPair.publicKey.toString('hex') : String(opts.keyPair.publicKey)

    if (!this.#roleBase || typeof this.#roleBase.can !== 'function') {
      throw new Error('RoleBase is required for closed-mode writer authorization but is not attached')
    }
    const authorized = await this.#roleBase.can(author, 'context.write')
    if (!authorized) {
      throw new Error('Not authorized to add writers to this context')
    }

    const event = { type: 'roles/addWriter', key: keyHex, author, timestamp: Date.now(), signature: null }
    const digest = this.#stableWriterChangeHash(event)
    event.signature = hypercoreCrypto.sign(digest, opts.keyPair.secretKey).toString('hex')

    await this.append(event)
  }

  /**
   * Remove a writer from the context. Same authorization/signing model as
   * addWriter() (unrestricted in open mode, signed + permission-checked in
   * closed mode). The Autobase-level removal itself refuses to remove the
   * last remaining indexer regardless of permission (host.removeWriter()
   * throws in that case, which the apply layer catches and ignores rather
   * than aborting the rest of the batch).
   *
   * @param {Buffer|string} coreKey - The writer's core key (hex string or Buffer)
   * @param {Object} [opts] - Options object
   * @param {Object} [opts.keyPair] - Required in closed mode: { publicKey, secretKey } to sign the event
   * @returns {Promise<void>}
   * @throws {Error} If keyPair is missing in closed mode, RoleBase is required but not attached, or authorization fails
   */
  async removeWriter (coreKey, opts = {}) {
    if (!this.opened) await this.ready()

    const key = Buffer.isBuffer(coreKey) ? coreKey : Buffer.from(coreKey, 'hex')
    const keyHex = key.toString('hex')

    if (this.#writeMode !== 'closed') {
      await this.append({ type: 'roles/removeWriter', key: keyHex })
      return
    }

    if ((await this.#record()).version === 3) {
      const author = this.#signer(opts.keyPair, 'removeWriter')
      if (!(await this.#can(this.#base.view, author, 'context.write'))) throw new Error('Not authorized to remove writers from this context')
      const event = { type: 'roles/removeWriter', key: keyHex, author, timestamp: Date.now(), signature: null }
      event.signature = hypercoreCrypto.sign(this.#stableWriterChangeHash(event), opts.keyPair.secretKey).toString('hex')
      await this.append(event)
      return
    }

    if (!opts.keyPair || !opts.keyPair.publicKey || !opts.keyPair.secretKey) {
      throw new Error('opts.keyPair (with publicKey and secretKey) is required in closed mode to sign the removeWriter event')
    }
    const author = b4a.isBuffer(opts.keyPair.publicKey) ? opts.keyPair.publicKey.toString('hex') : String(opts.keyPair.publicKey)

    if (!this.#roleBase || typeof this.#roleBase.can !== 'function') {
      throw new Error('RoleBase is required for closed-mode writer authorization but is not attached')
    }
    const authorized = await this.#roleBase.can(author, 'context.write')
    if (!authorized) {
      throw new Error('Not authorized to remove writers from this context')
    }

    const event = { type: 'roles/removeWriter', key: keyHex, author, timestamp: Date.now(), signature: null }
    const digest = this.#stableWriterChangeHash(event)
    event.signature = hypercoreCrypto.sign(digest, opts.keyPair.secretKey).toString('hex')

    await this.append(event)
  }

  // ========================================
  // Read Operations
  // ========================================

  /**
   * The index layout this context's view uses, from its own record. Until
   * the record has arrived there is nothing to read anyway, so the answer
   * is only cached once it exists.
   *
   * @returns {Promise<Object>} One of src/index-layout/context.js's layouts.
   */
  async #readIndex () {
    if (this.#index) return this.#index
    const keyHex = this.key.toString('hex')

    // Known locally: no read of the shared view at all. On a peer that holds
    // only part of the view, the record's path at the latest version may not
    // be held, and offline such a read waits forever, although the page the
    // app wants is held.
    const known = this.#localLayout ? await this.#localLayout.get(keyHex) : 0
    if (known && layoutFor({ layout: known })) {
      this.#index = layoutFor({ layout: known })
      return this.#index
    }

    const view = this.#base.view
    const entry = view ? await view.get(CONTEXT_RECORD_KEY) : null
    const index = layoutFor(entry && entry.value)
    // Remembered only once the record itself was read. A missing record
    // proves nothing: a joining peer can see a view that holds only its
    // header block for a moment, and concluding "layout 1" from that made
    // it read the wrong keys for good (test/brittle/replication/join-polling.js).
    // Contexts from before records (version 1) are layout 1 and simply
    // keep reading the view each time.
    if (!entry || !index) return index || layoutFor(null)
    this.#index = index
    if (this.#localLayout) await Promise.resolve(this.#localLayout.put(keyHex, index.id)).catch(safetyCatch)
    return index
  }

  /**
   * Stored edges of an entity, deleted ones included (see the layout's
   * `edges`). Used by GraphView; apps use graph.edges().
   *
   * @param {string} entityId
   * @param {{ direction?: 'in'|'out', type?: string, reverse?: boolean, limit?: number }} [opts]
   * @returns {AsyncIterable<Object>}
   */
  async * indexedEdges (entityId, opts = {}) {
    if (!this.opened) await this.ready()
    const index = await this.#readIndex()
    yield * index.edges(this.#base.view, entityId, opts)
  }

  /**
   * The live edge from → to of a type, or null.
   *
   * @returns {Promise<Object|null>}
   */
  async activeEdge (from, type, to) {
    if (!this.opened) await this.ready()
    const edge = await (await this.#readIndex()).activeEdge(this.#base.view, from, type, to)
    return edge && !edge.deleted ? edge : null
  }

  /**
   * An edge counter.
   *
   * @param {'in'|'out'} direction
   * @returns {Promise<number>}
   */
  async edgeCount (direction, entityId, type) {
    if (!this.opened) await this.ready()
    return (await this.#readIndex()).getCount(this.#base.view, direction, entityId, type)
  }

  /**
   * Tag entries `{ entityId, tag, author, createdAt }` of one tag, or of
   * all tags when `tag` is null.
   *
   * @returns {AsyncIterable<Object>}
   */
  async * tagged (tag, opts = {}) {
    if (!this.opened) await this.ready()
    const index = await this.#readIndex()
    yield * index.tagged(this.#base.view, tag, opts)
  }

  /** @returns {Promise<boolean>} Whether anyone tagged `entityId` with `tag`. */
  async hasTag (entityId, tag) {
    if (!this.opened) await this.ready()
    return (await this.#readIndex()).hasTag(this.#base.view, entityId, tag)
  }

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
   * @param {boolean|Object} isInitiatorOrStream - Whether this side initiated the connection, or a stream to replicate to
   * @param {Object} [opts] - Replication options (passed to Autobase.replicate)
   * @returns {Object|void} The replication stream (if isInitiator is boolean)
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
    if (this.#interrupted) return
    await this.#base.update()
    // Only re-read the member list when it may have changed: an apply
    // added or removed a writer, a fast-forward replaced the system, or the
    // system's own member count moved (a reorder can drop a writer without
    // any call we see).
    const system = this.#base.system
    if (this.#membersDirty || (system && system.members !== this.#membersCount)) await this.#refreshMembers()

    const view = this.#viewBee || this.#base?.view
    if (!view) return

    // On a peer holding only part of the view, fetch the small control
    // records whenever the view grew, while a peer is likely reachable, so
    // role checks and the record stay readable offline. Not awaited.
    if (view.core && view.core.length !== this.#prefetchedAt && view.core.contiguousLength < view.core.length) {
      this.#prefetchedAt = view.core.length
      for (const key of [CONTEXT_RECORD_KEY, ROLES_KEY]) view.get(key).catch(safetyCatch)
    }

    if (!this.#moderationQueued) return

    try {
      await this.#drainPendingModeration(view)
    } catch (err) {
      this.#moderationQueued = true // try again next time
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

    // Cleared before the scan: anything queued meanwhile sets it again.
    this.#moderationQueued = false
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
      approve: async (approveOpts = {}) => {
        await this.addWriter(writerKey, approveOpts)
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
  async approveWriter (writerKey, opts = {}) {
    if (!this.opened) await this.ready()
    const keyHex = Buffer.isBuffer(writerKey) ? writerKey.toString('hex') : writerKey
    await this.addWriter(writerKey, opts)
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

module.exports = ContextBase
module.exports.parseInviteLink = parseInviteLink
