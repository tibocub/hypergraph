const ReadyResource = require('ready-resource')
const safetyCatch = require('safety-catch')
const crypto = require('crypto')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')

const { initRegistry, applyRoleEvent, can } = require('./roles-registry')

module.exports = class RoleBase extends ReadyResource {
  #store
  #bootstrap
  #namespace
  #base
  #viewBee

  constructor (store, bootstrapKey, opts = {}) {
    super()

    this.#store = store
    this.#bootstrap = bootstrapKey || null
    this.#namespace = this.#bootstrap
      ? this.#bootstrap.toString('hex')
      : `roles-new-${crypto.randomBytes(8).toString('hex')}`

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

  get key () {
    return this.#base?.key
  }

  get discoveryKey () {
    return this.#base?.discoveryKey
  }

  async update () {
    if (!this.opened) await this.ready()
    return this.#base.update()
  }

  async getRegistry () {
    if (!this.opened) await this.ready()
    const entry = await this.#base.view.get('roles:registry')
    return entry ? entry.value : null
  }

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
    }

    await this.#base.append(event)
    await this.#base.update()
  }

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
