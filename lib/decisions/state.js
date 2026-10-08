// A space's state, as the decision log's view holds it (data-model.md):
// name, owner, members and their roles, which writer key speaks for which
// identity, invites used, cuts. Rebuilt from the view after every change.

const b4a = require('b4a')

// Built-in roles and their permissions (data-model.md). `decide` makes a
// member a writer of the decision log.
const ROLES = {
  owner: ['decide', 'moderate', 'invite', 'roles', 'post'],
  admin: ['decide', 'moderate', 'invite', 'roles', 'post'],
  moderator: ['moderate', 'post'],
  member: ['post'],
  guest: ['post']
}
const RANK = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 }

const toHex = (k) => (typeof k === 'string' ? k : b4a.toString(k, 'hex'))

function can (role, permission) {
  return !!role && !!ROLES[role] && ROLES[role].includes(permission)
}

class State {
  constructor () {
    this.meta = null
    this.members = new Map() // identity hex -> { role, by, stamp }
    this.writers = new Map() // writer key hex -> identity hex
    this.redeemed = new Map() // `${invite id hex}:${identity hex}` -> { at, by }
    this.uses = new Map() // invite id hex -> count
    this.cuts = new Map() // identity hex -> { log hex: length } (research.md A4)
  }

  static from (entries) {
    const state = new State()
    for (const [key, value] of entries) {
      if (key === 'meta') state.meta = value
      else if (key.startsWith('member:')) state.members.set(key.slice(7), value)
      else if (key.startsWith('writer:')) state.writers.set(key.slice(7), value.identity)
      else if (key.startsWith('redeemed:')) state.redeemed.set(key.slice(9), value)
      else if (key.startsWith('uses:')) state.uses.set(key.slice(5), value.count)
      else if (key.startsWith('cut:')) state.cuts.set(key.slice(4), value.logs)
    }
    return state
  }

  get name () { return this.meta ? this.meta.name : null }
  get owner () { return this.meta ? this.meta.owner : null }

  isMember (identity) {
    return this.members.has(toHex(identity))
  }

  roleOf (identity) {
    const m = this.members.get(toHex(identity))
    return m ? m.role : null
  }

  can (identity, permission) {
    return can(this.roleOf(identity), permission)
  }

  // May this identity write records in the space now?
  canWrite (identity) {
    return this.can(identity, 'post')
  }

  // How much of an identity's device log counts: records below the limit are
  // kept, the rest ignored. A cut, once recorded for a log, stays its limit
  // for good; otherwise everything if the identity may write, nothing if not.
  limitOf (identity, logKey) {
    const cut = this.cuts.get(toHex(identity))
    const length = cut ? cut[toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.canWrite(identity) ? Infinity : 0
  }

  isCut (identity, logKey) {
    const cut = this.cuts.get(toHex(identity))
    return !!cut && cut[toHex(logKey)] !== undefined
  }

  identityOfWriter (writerKey) {
    return this.writers.get(toHex(writerKey)) || null
  }

  toJSON () {
    return {
      meta: this.meta,
      members: [...this.members].sort(),
      writers: [...this.writers].sort(),
      redeemed: [...this.redeemed].sort(),
      uses: [...this.uses].sort(),
      cuts: [...this.cuts].sort()
    }
  }
}

module.exports = { State, ROLES, RANK, can, toHex }
