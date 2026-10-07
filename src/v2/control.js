const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const crypto = require('crypto')
const hcrypto = require('hypercore-crypto')
const b4a = require('b4a')
const safetyCatch = require('safety-catch')
const { EventEmitter } = require('events')
const { verifyInvite, verifyRedemption, inviteEnc, redemptionEnc } = require('./invites')

const hex = (b) => b4a.toString(b, 'hex')
const decodeHex = (enc, s) => { try { return typeof s === 'string' ? enc.decode(b4a.from(s, 'hex')) : null } catch { return null } }

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
const isHex32 = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s)

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

class Control extends EventEmitter {
  constructor (store, key, { wakeup } = {}) {
    super()
    this.base = new Autobase(store, key || null, {
      valueEncoding: 'json',
      ackInterval: 1000,
      ackThreshold: 0,
      wakeup,
      open: (s) => new Hyperbee(s.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: this._apply.bind(this)
    })
    this.state = emptyState()
    this._reloading = null
    this._again = false
    // The view moves when anyone's event arrives, not only when this peer
    // calls update(): keep the state current and say so ('change').
    this.base.on('update', () => this.reload().catch(safetyCatch))
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
  // One reload at a time; a call during one runs another after it.
  async reload () {
    if (this._reloading) {
      this._again = true
      return this._reloading
    }
    this._reloading = (async () => {
      do {
        this._again = false
        await this._read()
      } while (this._again)
    })()
    try {
      await this._reloading
    } finally {
      this._reloading = null
    }
    this.emit('change')
  }

  async _read () {
    const state = emptyState()
    const view = this.base.view
    if (!view) return
    for await (const { key, value } of view.createReadStream()) {
      if (key === 'meta:community') state.meta = value
      else if (key.startsWith('role:')) state.roles[key.slice(5)] = value
      else if (key.startsWith('channel:')) state.channels[key.slice(8)] = value
      else if (key.startsWith('ban:')) state.bans[key.slice(4)] = value
      else if (key.startsWith('hide:')) state.hides[key.slice(5)] = value
      else if (key.startsWith('epoch:')) {
        const [channel, n] = key.slice(6).split(':')
        ;(state.epochs[channel] = state.epochs[channel] || {})[n] = value
      } else if (key.startsWith('redeemed:')) {
        state.redeemed[key.slice(9)] = value
      } else if (key.startsWith('invite-revoked:')) {
        state.invitesRevoked[key.slice(15)] = value
      } else if (key.startsWith('uses:')) {
        state.uses[key.slice(5)] = value.count
      } else if (key.startsWith('revoked:')) {
        const [channel, member] = key.slice(8).split(':')
        ;(state.revoked[channel] = state.revoked[channel] || {})[member] = value
      }
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
        case 'channel': {
          if (!atLeast(authorRole, 'admin') || typeof event.id !== 'string' || !event.id) break
          if (await view.get(`channel:${event.id}`)) break
          // Private: epoch 0's commitment comes with it (spec 008, R4).
          const priv = event.private === true
          if (priv && !isHex32(event.commit)) break
          await view.put(`channel:${event.id}`, {
            name: String(event.name || ''),
            segmentMs: Number.isInteger(event.segmentMs) && event.segmentMs > 0 ? event.segmentMs : 3600000,
            createdAt: event.timestamp,
            by: event.author,
            ...(priv ? { private: true, epoch: 0, memberGrants: event.memberGrants === true } : {})
          })
          if (priv) await view.put(`epoch:${event.id}:0`, { commit: event.commit, by: event.author, at: event.timestamp })
          // Created to be kept by its creator: the keeper record too, in the
          // same event.
          if (typeof event.rosterKey === 'string') await view.put(`keeper:${event.id}:${event.author}`, { rosterKey: event.rosterKey })
          break
        }
        case 'rotate': {
          // One epoch up, from an admin; of two rotations to the same epoch
          // the first ordered wins on every peer (spec 008, R4).
          if (!atLeast(authorRole, 'admin') || !isHex32(event.commit)) break
          const node = await view.get(`channel:${event.channel}`)
          if (!node || !node.value.private || event.epoch !== node.value.epoch + 1) break
          await view.put(`channel:${event.channel}`, { ...node.value, epoch: event.epoch })
          await view.put(`epoch:${event.channel}:${event.epoch}`, { commit: event.commit, by: event.author, at: event.timestamp })
          break
        }
        case 'redeem': {
          // A newcomer's redemption of an invite, recorded by any writer (the
          // maker can be offline). Decided here, the same on every peer
          // (spec 008, R6): signatures, the maker's right at this point,
          // revocation, expiry against this recorder's time, uses per
          // distinct identity.
          if (!atLeast(authorRole, 'keeper')) break
          const r = decodeHex(redemptionEnc, event.redemption)
          if (!r || !verifyRedemption(r)) break
          const inv = r.invite
          if (!this.base.key || !b4a.equals(inv.community, this.base.key)) break
          const id = hex(inv.id)
          const identity = hex(r.identity)
          if (await view.get(`redeemed:${id}:${identity}`)) break // the same person counts once
          if (await view.get(`invite-revoked:${id}`)) break
          if (inv.expires && event.timestamp > inv.expires) break
          const usesNode = await view.get(`uses:${id}`)
          const used = usesNode ? usesNode.value.count : 0
          if (inv.uses && used >= inv.uses) break
          const makerRole = await roleOf(hex(inv.maker))
          const current = await roleOf(identity)
          if (inv.role && !mayAssign(makerRole, current, inv.role)) break
          let channelsOk = true
          for (const ch of inv.channels) {
            const node = await view.get(`channel:${ch}`)
            if (!node || !node.value.private || (!atLeast(makerRole, 'admin') && !node.value.memberGrants)) channelsOk = false
          }
          if (!channelsOk) break
          // The role, never a step down for someone already above it.
          if (inv.role && (RANK[current] || 0) < RANK[inv.role]) {
            const writer = r.writer ? hex(r.writer) : null
            await view.put(`role:${identity}`, { role: inv.role, writer, by: hex(inv.maker) })
            if (writer) await host.addWriter(r.writer, { indexer: inv.role === 'admin' })
          }
          await view.put(`redeemed:${id}:${identity}`, { channels: inv.channels, encryptionKey: hex(r.encryptionKey), role: inv.role, maker: hex(inv.maker), at: event.timestamp, by: event.author })
          await view.put(`uses:${id}`, { count: used + 1 })
          break
        }
        case 'revokeInvite': {
          const inv = decodeHex(inviteEnc, event.invite)
          if (!inv || !verifyInvite(inv)) break
          if (!atLeast(authorRole, 'admin') && event.author !== hex(inv.maker)) break
          await view.put(`invite-revoked:${hex(inv.id)}`, { by: event.author, at: event.timestamp })
          break
        }
        case 'revoke':
        case 'unrevoke': {
          if (!atLeast(authorRole, 'admin') || typeof event.member !== 'string') break
          const node = await view.get(`channel:${event.channel}`)
          if (!node || !node.value.private) break
          if (event.type === 'revoke') await view.put(`revoked:${event.channel}:${event.member}`, { by: event.author, at: event.timestamp })
          else await view.del(`revoked:${event.channel}:${event.member}`)
          break
        }
        case 'ban':
          if (!atLeast(authorRole, 'mod') || (await roleOf(event.member)) === 'owner') break
          await view.put(`ban:${event.member}`, { at: event.timestamp, reason: event.reason || '', by: event.author, cut: banCut(event.cut) })
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
  return { meta: null, roles: {}, channels: {}, bans: {}, hides: {}, keepers: {}, epochs: {}, revoked: {}, redeemed: {}, invitesRevoked: {}, uses: {} }
}

// A ban's cut: { logHex: length } for the banned author's logs, as the mod
// saw them. Readers show those logs only below the cut, whatever times the
// author claims (a claimed time can be backdated). Anything malformed is
// dropped, leaving the time rule.
const MAX_CUT = 1000
function banCut (cut) {
  const out = {}
  if (!cut || typeof cut !== 'object' || Array.isArray(cut)) return out
  let n = 0
  for (const [log, length] of Object.entries(cut)) {
    if (n >= MAX_CUT) break
    if (!/^[0-9a-f]{64}$/.test(log) || !Number.isInteger(length) || length < 0) continue
    out[log] = length
    n++
  }
  return out
}

module.exports = { Control, sign, verify, mayAssign, RANK }
