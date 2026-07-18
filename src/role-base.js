const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const crypto = require('crypto')
const hypercoreCrypto = require('hypercore-crypto')
const b4a = require('b4a')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const { initRegistry, applyRoleEvent, can } = require('./roles-registry')

/**
 * RoleBase manages role-based access control using Autobase.
 *
 * Provides a collaborative registry for roles and permissions, supporting
 * role assignment, permission configuration, and authorization checks.
 *
 * @extends ReadyResource
 */
module.exports = class RoleBase extends ReadyResource {
  #store
  #bootstrap
  #base
  #viewBee
  #identity

  /**
   * Create a new RoleBase instance.
   *
   * @param {Object} store - Corestore instance for core management
   * @param {Buffer|string|null} bootstrapKey - Autobase key to join existing RoleBase, or null to create new
   * @param {Object} [opts] - Configuration options
   * @param {Object} [opts.identity] - IdentityManager instance for signing
   */
  constructor (store, bootstrapKey, opts = {}) {
    super()

    this.#store = store
    this.#bootstrap = bootstrapKey || null
    this.#identity = opts.identity || null

    this.#base = null
    this.#viewBee = null

    this.ready().catch(safetyCatch)
  }

  async _open () {
    this.#base = new Autobase(this.#store, this.#bootstrap, {
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
        case 'roles/init':
        case 'roles/setRole':
        case 'roles/removeMember':
        case 'roles/setRolePermissions':
          await this.#applyRolesEvent(view, event)
          break

        case 'roles/config/put':
          await this.#applyConfigPut(view, event)
          break
      }
    }
  }

  async #applyRolesEvent (view, event) {
    let current = null

    try {
      const entry = await view.get('roles:registry')
      current = entry ? entry.value : null
    } catch {
      current = null
    }

    let next = null
    try {
      next = applyRoleEvent(current, event)
    } catch {
      return
    }

    await view.put('roles:registry', next)

    if (event.type === 'roles/init') {
      if (next && next.members && typeof next.members === 'object') {
        for (const [member, role] of Object.entries(next.members)) {
          await view.put(`roles:member:${member}`, { role })
        }
      }
    } else if (event.type === 'roles/setRole') {
      if (event.member && typeof event.member === 'string') {
        await view.put(`roles:member:${event.member}`, { role: event.role })
      }
    } else if (event.type === 'roles/removeMember') {
      if (event.member && typeof event.member === 'string') {
        await view.del(`roles:member:${event.member}`)
      }
    }
  }

  async #applyConfigPut (view, event) {
    if (!event.key || typeof event.key !== 'string') return
    await view.put(`config:${event.key}`, {
      key: event.key,
      value: event.value === undefined ? null : event.value,
      author: event.author || null,
      timestamp: typeof event.timestamp === 'number' ? event.timestamp : null
    })
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
   * Update the RoleBase from remote peers.
   *
   * @returns {Promise<boolean>} True if the base was updated, false otherwise
   */
  async update () {
    if (!this.opened) await this.ready()
    return this.#base.update()
  }

  /**
   * Get the current role registry state.
   *
   * @returns {Promise<Object|null>} The role registry, or null if not initialized
   */
  async getRegistry () {
    if (!this.opened) await this.ready()
    const entry = await this.#base.view.get('roles:registry')
    return entry ? entry.value : null
  }

  /**
   * Check if a public key has permission to perform an action.
   *
   * BUG FIX: this method was expected to exist by ContextBase (which already
   * checked `typeof this.#roleBase.can === 'function'` and called it for
   * moderation permission checks), but was never actually added — meaning
   * that check always silently failed and moderation events were always
   * queued as pending rather than actually evaluated against the registry,
   * even when a RoleBase was properly attached. The standalone `can()`
   * function this wraps was already imported and used internally in this
   * file for role-modification checks; it just wasn't exposed for external
   * callers.
   *
   * @param {string} pubkeyHex - The public key to check (hex string)
   * @param {string} action - The action to check permission for
   * @returns {Promise<boolean>} True if the key has permission
   */
  async can (pubkeyHex, action) {
    if (!this.opened) await this.ready()
    const registry = await this.getRegistry()
    return can(registry, pubkeyHex, action)
  }

  /**
   * Append a role management event to the RoleBase.
   *
   * Performs authorization checks for role modification events.
   *
   * @param {Object} event - The role event to append
   * @returns {Promise<void>}
   * @throws {Error} If the event type is invalid, registry is missing, or authorization fails
   */
  async append (event) {
    if (!this.opened) await this.ready()

    if (!event || typeof event.type !== 'string') {
      throw new Error('event.type is required')
    }

    if (
      event.type === 'roles/setRole' ||
      event.type === 'roles/removeMember' ||
      event.type === 'roles/setRolePermissions'
    ) {
      const registry = await this.getRegistry()
      if (!registry) throw new Error('Role registry missing')

      let required = null
      if (event.type === 'roles/setRole') {
        required = event.role === 'owner' ? '*' : 'mod.add'
      } else if (event.type === 'roles/removeMember') {
        required = 'mod.remove'
      } else if (event.type === 'roles/setRolePermissions') {
        required = '*'
      }

      if (!event.author || typeof event.author !== 'string') throw new Error('event.author is required')
      if (!can(registry, event.author, required)) throw new Error('Not authorized')

      // Sign the event using identity
      if (this.#identity) {
        const deviceKeyPair = this.#identity.deviceKeyPair
        const digest = this.#stableRoleHash(event)
        const sig = hypercoreCrypto.sign(digest, deviceKeyPair.secretKey)
        event.signature = sig.toString('hex')
      }
    }

    await this.#base.append(event)
    await this.#base.update()
  }

  #stableRoleHash (event) {
    const payload = {
      pubkey: event.pubkey,
      role: event.role || null
    }

    const msg = {
      op: event.type,
      payload,
      author: event.author,
      timestamp: Date.now()
    }

    return crypto.createHash('sha256').update(JSON.stringify(msg)).digest()
  }

  /**
   * Initialize a new role registry with an owner.
   *
   * @param {string} ownerPubkeyHex - The owner's hex public key
   * @param {string} [authorPubkeyHex] - The author's hex public key (defaults to owner)
   * @returns {Promise<void>}
   */
  async init (ownerPubkeyHex, authorPubkeyHex) {
    if (!this.opened) await this.ready()

    const registry = initRegistry(ownerPubkeyHex)

    const event = {
      type: 'roles/init',
      author: authorPubkeyHex || ownerPubkeyHex,
      timestamp: Date.now(),
      registry
    }

    await this.#base.append(event)
    await this.#base.update()
  }

  /**
   * Add a new owner to the role registry.
   *
   * Requires '*' privilege. Adds the writer core and assigns the owner role.
   *
   * @param {string} memberPubkeyHex - The new owner's hex public key
   * @param {Object} writerCore - The writer core to add
   * @param {Object} [opts] - Options object
   * @param {string} [opts.author] - The author's hex public key (must have '*' privilege)
   * @returns {Promise<void>}
   * @throws {Error} If parameters are missing or authorization fails
   */
  async addOwner (memberPubkeyHex, writerCore, opts = {}) {
    if (!this.opened) await this.ready()

    if (!memberPubkeyHex || typeof memberPubkeyHex !== 'string') throw new Error('memberPubkeyHex is required')
    if (!writerCore || !writerCore.key) throw new Error('writerCore with a key is required')

    const registry = await this.getRegistry()
    if (!registry) throw new Error('Role registry missing')

    const author = opts.author
    if (!author || typeof author !== 'string') throw new Error('opts.author is required')
    if (!can(registry, author, '*')) throw new Error('Not authorized')

    const writerKeyHex = writerCore.key.toString('hex')

    const events = [
      { type: 'roles/addWriter', key: writerKeyHex },
      { type: 'roles/setRole', member: memberPubkeyHex, role: 'owner', author, timestamp: Date.now() }
    ]

    await this.#base.append(events)
    await this.#base.update()
  }
}
