const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const crypto = require('crypto')
const hypercoreCrypto = require('hypercore-crypto')
const b4a = require('b4a')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const { applyScopeEvent, getGrant } = require('./scopes-registry')
const { can } = require('./roles-registry')

/**
 * ScopeBase manages read-access scopes: named, key-holder-restricted
 * "views" of content. Structurally mirrors RoleBase (its own Autobase, its
 * own apply function) but a different concern — RoleBase decides who is
 * allowed to do what; ScopeBase stores sealed key material for who has
 * actually been granted the ability to decrypt a given scope's content.
 *
 * A scope's actual symmetric key never appears anywhere in this structure
 * in the clear — only copies sealed (crypto_box_seal, via
 * hypercore-crypto's encrypt()/decrypt()) to a specific recipient's stable,
 * per-identity encryption public key. Anyone can replicate this entire
 * structure; only the intended recipient of a given sealed grant can
 * actually open it.
 *
 * @extends ReadyResource
 */
module.exports = class ScopeBase extends ReadyResource {
  #store
  #bootstrap
  #namespace
  #base
  #viewBee
  #identity
  #roleBase

  /**
   * Create a new ScopeBase instance.
   *
   * @param {Object} store - Corestore instance for core management
   * @param {Buffer|string|null} bootstrapKey - Autobase key to join an existing ScopeBase, or null to create new
   * @param {Object} [opts] - Configuration options
   * @param {Object} [opts.identity] - IdentityManager instance, for signing and this identity's own encryptionKeyPair
   * @param {Object} [opts.roleBase] - RoleBase instance, for permission checks on scope actions (scope.create/scope.grant/scope.revoke)
   */
  constructor (store, bootstrapKey, opts = {}) {
    super()

    this.#store = store
    this.#bootstrap = bootstrapKey || null
    // Namespaced, mirroring ContextBase exactly — without this, ScopeBase
    // collides with RoleBase (the only other Autobase in the system that
    // also uses the raw store directly): both would try to use the same
    // "view" core name on the same underlying Corestore, since neither
    // namespaces on its own. Confirmed directly: reproduced this hang
    // with a minimal, two-raw-Autobase repro with no application code
    // involved at all, then confirmed namespacing one of them resolves it.
    this.#namespace = this.#bootstrap
      ? this.#bootstrap.toString('hex')
      : `scope-${hypercoreCrypto.randomBytes(8).toString('hex')}`
    this.#identity = opts.identity || null
    this.#roleBase = opts.roleBase || null

    this.#base = null
    this.#viewBee = null

    this.ready().catch(safetyCatch)
  }

  async _open () {
    const ns = this.#store.namespace(this.#namespace)
    this.#base = new Autobase(ns, this.#bootstrap, {
      open: this.#openView.bind(this),
      apply: this.#applyView.bind(this),
      valueEncoding: 'json',
      ackInterval: 0,
      ackThreshold: 0,
      fastForward: false
    })

    await this.#base.ready()
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
    for (const { value: event } of batch) {
      if (!event || typeof event.type !== 'string') continue

      if (event.type === 'roles/addWriter') {
        try {
          const key = Buffer.isBuffer(event.key) ? event.key : Buffer.from(event.key, 'hex')
          await host.addWriter(key, { indexer: true })
        } catch {}
        continue
      }

      switch (event.type) {
        case 'scope/create':
        case 'scope/keyGrant':
        case 'scope/revoke':
          await this.#applyScopeEvent(view, event)
          break
      }
    }
  }

  async #applyScopeEvent (view, event) {
    if (!this.#verifyScopeEventSignature(event)) return

    const allowed = await this.#isScopeActionAllowed(event)
    if (allowed === false) return
    // allowed === null: RoleBase not attached or not yet synced — the
    // event is simply dropped here rather than queued as pending. Unlike
    // moderation/writer-change events (which are core hypergraph
    // concerns with an established pending-queue pattern), a dropped
    // scope event is recoverable the same way any missed event is: the
    // granter's own state still has it, and can re-append/re-sync. This
    // keeps the first version of this feature simpler; revisit if this
    // turns out to matter in practice.
    if (allowed === null) return

    let current = null
    try {
      const entry = await view.get('scopes:registry')
      current = entry ? entry.value : null
    } catch {
      current = null
    }

    let next = null
    try {
      next = applyScopeEvent(current, event)
    } catch {
      return
    }

    await view.put('scopes:registry', next)
  }

  async #isScopeActionAllowed (event) {
    if (!this.#roleBase || typeof this.#roleBase.getRegistry !== 'function' || typeof this.#roleBase.can !== 'function') {
      return null
    }

    const requiredPermission = event.type === 'scope/create'
      ? 'scope.create'
      : event.type === 'scope/revoke'
        ? 'scope.revoke'
        : 'scope.grant'

    // Bounded retry, matching #isModerationAllowed/#isWriterChangeAllowed's
    // own reasoning: the RoleBase and this structure are two independent
    // Autobase structures replicating concurrently, so the registry may
    // simply not have arrived yet at the moment this event is first
    // processed.
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
      return can(registry, event.author, requiredPermission)
    } catch {
      return false
    }
  }

  #verifyScopeEventSignature (event) {
    if (typeof event.author !== 'string' || event.author.length === 0) return false
    if (typeof event.timestamp !== 'number') return false
    if (typeof event.signature !== 'string' || event.signature.length === 0) return false

    if (event.type === 'scope/create') {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) return false
      if (typeof event.creator !== 'string' || event.creator.length === 0) return false
    } else if (event.type === 'scope/keyGrant') {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) return false
      if (typeof event.recipient !== 'string' || event.recipient.length === 0) return false
      if (typeof event.epoch !== 'number' || event.epoch < 0) return false
      if (typeof event.sealedKey !== 'string' || event.sealedKey.length === 0) return false
      if (typeof event.recipientEncryptionPublicKey !== 'string' || event.recipientEncryptionPublicKey.length === 0) return false
    } else if (event.type === 'scope/revoke') {
      if (typeof event.scopeId !== 'string' || event.scopeId.length === 0) return false
      if (typeof event.pubkey !== 'string' || event.pubkey.length === 0) return false
    } else {
      return false
    }

    let publicKey = null
    let signature = null
    try {
      publicKey = b4a.from(event.author, 'hex')
      signature = b4a.from(event.signature, 'hex')
    } catch {
      return false
    }

    const digest = this.#stableScopeHash(event)
    return hypercoreCrypto.verify(digest, signature, publicKey)
  }

  #stableScopeHash (event) {
    let payload
    if (event.type === 'scope/create') {
      payload = { scopeId: event.scopeId, creator: event.creator }
    } else if (event.type === 'scope/keyGrant') {
      payload = { scopeId: event.scopeId, recipient: event.recipient, epoch: event.epoch, sealedKey: event.sealedKey, recipientEncryptionPublicKey: event.recipientEncryptionPublicKey }
    } else {
      payload = { scopeId: event.scopeId, pubkey: event.pubkey }
    }

    const msg = {
      op: event.type,
      payload,
      author: event.author,
      timestamp: event.timestamp
    }

    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  /** @returns {Buffer|undefined} The Autobase public key */
  get key () {
    return this.#base?.key
  }

  /** @returns {Buffer|undefined} The Autobase discovery key */
  get discoveryKey () {
    return this.#base?.discoveryKey
  }

  /**
   * Update the ScopeBase from remote peers.
   *
   * @returns {Promise<boolean>} True if the base was updated, false otherwise
   */
  async update () {
    if (!this.opened) await this.ready()
    return this.#base.update()
  }

  /**
   * Get the current registry state for all scopes hosted here.
   *
   * @returns {Promise<Object|null>} Map of { [scopeId]: scopeState }, or null if empty
   */
  async getRegistry () {
    if (!this.opened) await this.ready()
    const entry = await this.#base.view.get('scopes:registry')
    return entry ? entry.value : null
  }

  #sign (event) {
    if (!this.#identity) throw new Error('An identity is required to sign scope events')
    const deviceKeyPair = this.#identity.deviceKeyPair
    const digest = this.#stableScopeHash(event)
    const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
    event.signature = sig.toString('hex')
  }

  /**
   * Create a new scope and immediately grant its creator the key for
   * epoch 0 — a scope always starts with its creator as the first (and,
   * at creation time, only) member able to decrypt its content.
   *
   * @param {string} scopeId - A unique id for the new scope
   * @returns {Promise<{ scopeId: string, key: Buffer }>} The scope id and its raw symmetric key (32 bytes)
   * @throws {Error} If no identity is attached, or the creator lacks scope.create permission
   */
  async createScope (scopeId) {
    if (!this.opened) await this.ready()
    if (!this.#identity) throw new Error('An identity is required to create a scope')
    if (typeof scopeId !== 'string' || scopeId.length === 0) throw new Error('scopeId is required')

    const author = this.#identity.deviceKeyPair.publicKey.toString('hex')

    const createEvent = {
      type: 'scope/create',
      scopeId,
      creator: author,
      author,
      timestamp: Date.now(),
      signature: null
    }
    this.#sign(createEvent)

    const key = hypercoreCrypto.randomBytes(32)
    const sealedKey = hypercoreCrypto.encrypt(key, this.#identity.encryptionKeyPair.publicKey).toString('hex')

    const grantEvent = {
      type: 'scope/keyGrant',
      scopeId,
      recipient: author,
      epoch: 0,
      sealedKey,
      recipientEncryptionPublicKey: this.#identity.encryptionKeyPair.publicKey.toString('hex'),
      granter: author,
      author,
      timestamp: Date.now(),
      signature: null
    }
    this.#sign(grantEvent)

    await this.#base.append([createEvent, grantEvent])
    await this.#base.update()

    return { scopeId, key }
  }

  /**
   * Resolve a scope's key for a given epoch, for a specific recipient.
   * Unseals the recipient's own grant using their encryptionKeyPair — only
   * the intended recipient (any of their devices, since encryptionKeyPair
   * is stable per-identity) can actually do this.
   *
   * @param {string} scopeId - The scope id
   * @param {string} pubkeyHex - The recipient's hex public key (their signing/author identity)
   * @param {Object} encryptionKeyPair - The recipient's own encryptionKeyPair, to unseal with
   * @param {number} epoch - Which epoch's key to resolve
   * @returns {Promise<Buffer|null>} The raw 32-byte key, or null if no grant exists for this recipient/epoch, or it can't be unsealed
   */
  async resolveKey (scopeId, pubkeyHex, encryptionKeyPair, epoch) {
    if (!this.opened) await this.ready()

    const registry = await this.getRegistry()
    const grant = getGrant(registry, scopeId, pubkeyHex, epoch)
    if (!grant) return null

    try {
      const sealed = b4a.from(grant.sealedKey, 'hex')
      return hypercoreCrypto.decrypt(sealed, encryptionKeyPair)
    } catch {
      return null
    }
  }

  /**
   * Get a scope's current epoch number.
   *
   * @param {string} scopeId - The scope id
   * @returns {Promise<number|null>} The current epoch, or null if the scope doesn't exist
   */
  async getCurrentEpoch (scopeId) {
    if (!this.opened) await this.ready()
    const registry = await this.getRegistry()
    if (!registry || !registry[scopeId]) return null
    return registry[scopeId].currentEpoch
  }

  /**
   * Grant a scope's key (at its current epoch) to a new recipient.
   *
   * Requires the granter to already hold that epoch's key themselves —
   * this is an inherent cryptographic requirement, not just a policy
   * check: sealing a key to a new recipient requires actually having the
   * raw key bytes in hand. The scope.grant permission check (via
   * RoleBase) is an additional, independent layer on top of that.
   *
   * @param {string} scopeId - The scope id
   * @param {string} recipientPubkeyHex - The recipient's hex public key (their signing/author identity)
   * @param {Buffer} recipientEncryptionPublicKey - The recipient's stable encryptionKeyPair.publicKey to seal to
   * @returns {Promise<void>}
   * @throws {Error} If the granter doesn't hold the current key, or lacks scope.grant permission
   */
  async grantKey (scopeId, recipientPubkeyHex, recipientEncryptionPublicKey) {
    if (!this.opened) await this.ready()
    if (!this.#identity) throw new Error('An identity is required to grant a scope key')
    if (typeof scopeId !== 'string' || scopeId.length === 0) throw new Error('scopeId is required')
    if (typeof recipientPubkeyHex !== 'string' || recipientPubkeyHex.length === 0) throw new Error('recipientPubkeyHex is required')
    if (!recipientEncryptionPublicKey) throw new Error('recipientEncryptionPublicKey is required')

    const author = this.#identity.deviceKeyPair.publicKey.toString('hex')

    const epoch = await this.getCurrentEpoch(scopeId)
    if (epoch === null) throw new Error('Unknown scope')

    const myKey = await this.resolveKey(scopeId, author, this.#identity.encryptionKeyPair, epoch)
    if (!myKey) throw new Error('You do not hold the current key for this scope — cannot grant what you do not have')

    // Client-side fail-fast permission check, mirroring moderateAction()'s
    // pattern — but only a RoleBase that has a registry AND explicitly
    // denies the action throws here; no RoleBase attached at all passes
    // through (matching the same "not yet determined" philosophy used
    // elsewhere).
    if (this.#roleBase) {
      let registry = null
      try {
        registry = await this.#roleBase.getRegistry()
      } catch {
        registry = null
      }
      if (registry && !can(registry, author, 'scope.grant')) {
        throw new Error('Not authorized to grant this scope')
      }
    }

    const sealedKey = hypercoreCrypto.encrypt(myKey, recipientEncryptionPublicKey).toString('hex')

    const grantEvent = {
      type: 'scope/keyGrant',
      scopeId,
      recipient: recipientPubkeyHex,
      epoch,
      sealedKey,
      recipientEncryptionPublicKey: b4a.isBuffer(recipientEncryptionPublicKey) ? recipientEncryptionPublicKey.toString('hex') : String(recipientEncryptionPublicKey),
      granter: author,
      author,
      timestamp: Date.now(),
      signature: null
    }
    this.#sign(grantEvent)

    await this.#base.append(grantEvent)
    await this.#base.update()
  }

  /**
   * Mark a pubkey as revoked for a scope — an informational fact that
   * they are no longer a current member, going forward. Does not, and
   * cannot, undo any grant they already received; content encrypted under
   * an epoch they already had access to remains something they can
   * decrypt. Actual enforcement is that they simply stop receiving new
   * keyGrant events at future epochs.
   *
   * @param {string} scopeId - The scope id
   * @param {string} pubkeyHex - The pubkey to mark as revoked
   * @returns {Promise<void>}
   * @throws {Error} If the caller lacks scope.revoke permission
   */
  /**
   * Rotate a scope to a new key epoch, re-granting it to every current
   * member except any explicitly excluded pubkeys. This is the actual
   * mechanism for cutting someone off from *future* content — `revoke()`
   * alone only marks them informationally and does not stop them from
   * resolving already-granted epochs; this is what stops them from ever
   * receiving the new one.
   *
   * "Current members" means anyone holding a grant at the scope's current
   * epoch who isn't marked revoked and isn't in `opts.excludePubkeys`.
   * Requires the caller to hold that current epoch's key themselves (the
   * same inherent cryptographic requirement `grantKey()` has), and the
   * same `scope.grant` permission check — rotation is fundamentally a
   * mass-grant operation, not a new kind of action.
   *
   * @param {string} scopeId - The scope id
   * @param {Object} [opts]
   * @param {string[]} [opts.excludePubkeys] - Pubkeys to leave out of the re-grant (e.g. the member being cut off right now)
   * @returns {Promise<{ epoch: number, key: Buffer, grantedTo: string[] }>} The new epoch, its raw key, and who it was granted to
   * @throws {Error} If the scope is unknown, the caller doesn't hold the current key, lacks scope.grant permission, or there would be no one left to grant to
   */
  async rotateKey (scopeId, opts = {}) {
    if (!this.opened) await this.ready()
    if (!this.#identity) throw new Error('An identity is required to rotate a scope key')
    if (typeof scopeId !== 'string' || scopeId.length === 0) throw new Error('scopeId is required')

    const author = this.#identity.deviceKeyPair.publicKey.toString('hex')

    const registry = await this.getRegistry()
    const scope = registry ? registry[scopeId] : null
    if (!scope) throw new Error('Unknown scope')

    const currentEpoch = scope.currentEpoch
    const myKey = await this.resolveKey(scopeId, author, this.#identity.encryptionKeyPair, currentEpoch)
    if (!myKey) throw new Error('You do not hold the current key for this scope — cannot rotate a key you do not have')

    if (this.#roleBase) {
      let roleRegistry = null
      try {
        roleRegistry = await this.#roleBase.getRegistry()
      } catch {
        roleRegistry = null
      }
      if (roleRegistry && !can(roleRegistry, author, 'scope.grant')) {
        throw new Error('Not authorized to rotate this scope\'s key')
      }
    }

    // Current members: anyone with a grant at the current epoch, not
    // revoked, not explicitly excluded. recipientEncryptionPublicKey is
    // what lets us re-seal the new key to them without needing any
    // external identity lookup.
    const exclude = new Set((opts.excludePubkeys || []).map(String))
    const members = new Map()
    for (const key of Object.keys(scope.grants)) {
      const sep = key.lastIndexOf(':')
      const pubkey = key.slice(0, sep)
      const epochOfGrant = Number(key.slice(sep + 1))
      if (epochOfGrant !== currentEpoch) continue
      if (scope.revoked[pubkey]) continue
      if (exclude.has(pubkey)) continue
      const grant = scope.grants[key]
      if (!grant.recipientEncryptionPublicKey) continue
      members.set(pubkey, grant.recipientEncryptionPublicKey)
    }

    if (members.size === 0) {
      throw new Error('No current members to rotate the key to — rotating would leave no one with access')
    }

    const newEpoch = currentEpoch + 1
    const newKey = hypercoreCrypto.randomBytes(32)

    const events = []
    for (const [pubkey, encryptionPublicKeyHex] of members) {
      const sealedKey = hypercoreCrypto.encrypt(newKey, b4a.from(encryptionPublicKeyHex, 'hex')).toString('hex')
      const grantEvent = {
        type: 'scope/keyGrant',
        scopeId,
        recipient: pubkey,
        epoch: newEpoch,
        sealedKey,
        recipientEncryptionPublicKey: encryptionPublicKeyHex,
        granter: author,
        author,
        timestamp: Date.now(),
        signature: null
      }
      this.#sign(grantEvent)
      events.push(grantEvent)
    }

    await this.#base.append(events)
    await this.#base.update()

    return { epoch: newEpoch, key: newKey, grantedTo: [...members.keys()] }
  }

  async revoke (scopeId, pubkeyHex) {
    if (!this.opened) await this.ready()
    if (!this.#identity) throw new Error('An identity is required to revoke scope access')
    if (typeof scopeId !== 'string' || scopeId.length === 0) throw new Error('scopeId is required')
    if (typeof pubkeyHex !== 'string' || pubkeyHex.length === 0) throw new Error('pubkeyHex is required')

    const author = this.#identity.deviceKeyPair.publicKey.toString('hex')

    if (this.#roleBase) {
      let registry = null
      try {
        registry = await this.#roleBase.getRegistry()
      } catch {
        registry = null
      }
      if (registry && !can(registry, author, 'scope.revoke')) {
        throw new Error('Not authorized to revoke scope access')
      }
    }

    const event = {
      type: 'scope/revoke',
      scopeId,
      pubkey: pubkeyHex,
      author,
      timestamp: Date.now(),
      signature: null
    }
    this.#sign(event)

    await this.#base.append(event)
    await this.#base.update()
  }
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
