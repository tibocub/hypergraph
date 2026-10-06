const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')

// The community control log (spec 007, data-model.md): one Autobase written
// only by the owner, admins, mods and keepers. Every member applies it in
// full and takes membership, roles, moderation, channels and keepers from it
// alone. It grows with decisions, never with messages.

const RANK = { owner: 4, admin: 3, mod: 2, keeper: 1 }

// Who may set `member` to `role` (null removes it), given the author's role
// and the member's current role.
function mayAssign (authorRole, currentRole, role) {
  if (role === 'owner') return false
  if (authorRole === 'owner') return currentRole !== 'owner'
  if (authorRole === 'admin') return (role === null || role === 'mod' || role === 'keeper') && (currentRole === null || currentRole === 'mod' || currentRole === 'keeper')
  return false
}

const atLeast = (role, wanted) => (RANK[role] || 0) >= RANK[wanted]

function digest (communityHex, event) {
  const { signature, ...rest } = event
  const ordered = Object.keys(rest).sort().map(k => [k, rest[k]])
  return crypto.createHash('sha256').update(JSON.stringify(['hg-v2-control', communityHex, ordered])).digest()
}

function sign (communityHex, event, keyPair) {
  event.author = b4a.toString(keyPair.publicKey, 'hex')
  event.timestamp = event.timestamp || Date.now()
  event.signature = b4a.toString(hcrypto.sign(digest(communityHex, event), keyPair.secretKey), 'hex')
  return event
}

function verify (communityHex, event) {
  try {
    return typeof event.author === 'string' && typeof event.signature === 'string' &&
      hcrypto.verify(digest(communityHex, event), b4a.from(event.signature, 'hex'), b4a.from(event.author, 'hex'))
  } catch {
    return false
  }
}

class Control {
  constructor (store, key, { wakeup } = {}) {
    this.base = new Autobase(store, key || null, {
      valueEncoding: 'json',
      ackInterval: 1000,
      ackThreshold: 0,
      wakeup,
      open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: this._apply.bind(this)
    })
    this.state = emptyState()
  }

  get key () { return this.base.key }
  get hex () { return b4a.toString(this.base.key, 'hex') }
  get writable () { return this.base.writable }
  get localKey () { return this.base.local.key }

  async ready () {
    await this.base.ready()
    await this.reload()
  }

  async close () {
    await this.base.close()
  }

  async append (event) {
    if (!this.base.writable) throw new Error('This peer is not a writer of the control log')
    await this.base.append(event)
    await this.base.update()
    await this.reload()
  }

  async update () {
    await this.base.update()
    await this.reload()
  }

  // Rebuild the in-memory state from the view: a few hundred small records
  // at most (roles, channels, bans, hides, keepers), so a full read is cheap
  // and always matches the view, even after Autobase reorders.
  async reload () {
    const state = emptyState()
    const view = this.base.view
    if (!view) return
    for await (const { key, value } of view.createReadStream()) {
      if (key === 'meta:community') state.meta = value
      else if (key.startsWith('role:')) state.roles[key.slice(5)] = value
      else if (key.startsWith('channel:')) state.channels[key.slice(8)] = value
      else if (key.startsWith('ban:')) state.bans[key.slice(4)] = value
      else if (key.startsWith('hide:')) state.hides[key.slice(5)] = value
      else if (key.startsWith('keeper:')) {
        const [channel, keeper] = key.slice(7).split(':')
        ;(state.keepers[channel] = state.keepers[channel] || []).push({ keeper, rosterKey: value.rosterKey })
      }
    }
    this.state = state
  }

  async _apply (nodes, view, host) {
    const communityHex = b4a.toString(this.base.key, 'hex')
    const roleOf = async (pub) => {
      const entry = await view.get(`role:${pub}`)
      return entry ? entry.value.role : null
    }
    for (const { value: event, from } of nodes) {
      if (!event || typeof event.type !== 'string') continue

      if (event.type === 'init') {
        if (!from || !this.base.key || !b4a.equals(from.key, this.base.key)) continue
        if (await view.get('meta:community')) continue
        if (!verify(communityHex, event)) continue
        await view.put('meta:community', { version: 'v2-prototype', name: event.name || '', createdAt: event.timestamp })
        await view.put(`role:${event.author}`, { role: 'owner', writer: b4a.toString(from.key, 'hex'), by: event.author })
        continue
      }

      if (!verify(communityHex, event)) continue
      const authorRole = await roleOf(event.author)

      switch (event.type) {
        case 'role': {
          const current = await roleOf(event.member)
          const role = event.role || null
          if (!mayAssign(authorRole, current, role)) break
          const previous = await view.get(`role:${event.member}`)
          if (role === null) {
            await view.del(`role:${event.member}`)
            if (previous && previous.value.writer) {
              const key = b4a.from(previous.value.writer, 'hex')
              try { if (host.removeable(key)) await host.removeWriter(key) } catch (err) { safetyCatch(err) }
            }
            break
          }
          const writer = typeof event.writer === 'string' && event.writer.length === 64 ? event.writer : null
          await view.put(`role:${event.member}`, { role, writer, by: event.author })
          if (writer) await host.addWriter(b4a.from(writer, 'hex'), { indexer: role === 'admin' })
          break
        }
        case 'channel':
          if (!atLeast(authorRole, 'admin') || typeof event.id !== 'string' || !event.id) break
          if (await view.get(`channel:${event.id}`)) break
          await view.put(`channel:${event.id}`, {
            name: String(event.name || ''),
            segmentMs: Number.isInteger(event.segmentMs) && event.segmentMs > 0 ? event.segmentMs : 3600000,
            createdAt: event.timestamp,
            by: event.author
          })
          break
        case 'ban':
          if (!atLeast(authorRole, 'mod') || (await roleOf(event.member)) === 'owner') break
          await view.put(`ban:${event.member}`, { at: event.timestamp, reason: event.reason || '', by: event.author })
          break
        case 'unban':
          if (!atLeast(authorRole, 'mod')) break
          await view.del(`ban:${event.member}`)
          break
        case 'hide':
          if (!atLeast(authorRole, 'mod')) break
          await view.put(`hide:${event.member}:${event.log}:${event.seq}`, { reason: event.reason || '', by: event.author, at: event.timestamp })
          break
        case 'keeper':
          if (!atLeast(authorRole, 'keeper') || typeof event.rosterKey !== 'string' || typeof event.channel !== 'string') break
          await view.put(`keeper:${event.channel}:${event.author}`, { rosterKey: event.rosterKey })
          break
      }
    }
  }
}

function emptyState () {
  return { meta: null, roles: {}, channels: {}, bans: {}, hides: {}, keepers: {} }
}

module.exports = { Control, sign, verify, mayAssign, RANK }
