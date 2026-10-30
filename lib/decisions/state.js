// A space's state, as the decision log's view holds it (data-model.md):
// name, owner, members and their roles, custom roles, which writer key speaks
// for which identity, invites used, cuts, bans and moderation of records.
// Rebuilt from the view after every change.

const b4a = require('b4a')

// Built-in roles and their permissions (data-model.md). `decide` lets a member
// record decisions (members, roles, invites), `moderate` moderation decisions;
// either makes the member's device a writer of the decision log.
const ROLES = {
  owner: ['decide', 'moderate', 'invite', 'roles', 'post'],
  admin: ['decide', 'moderate', 'invite', 'roles', 'post'],
  moderator: ['moderate', 'post'],
  member: ['post'],
  guest: ['post']
}
const RANK = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 }
const CUSTOM_RANK = 2 // a custom role ranks as a member
const ACTIONS = ['flag', 'hide', 'reveal', 'remove', 'ban', 'unban']

const toHex = (k) => (typeof k === 'string' ? k : b4a.toString(k, 'hex'))

// Permissions of a role; `custom` maps custom role names to their lists.
function permissionsOf (role, custom) {
  if (!role) return null
  if (ROLES[role]) return ROLES[role]
  return custom.get(role) || null
}

function rankOf (role) {
  return RANK[role] || CUSTOM_RANK
}

// The owner holds every permission, the app's included (e.g. 'edit-pages').
function can (role, permission, custom = new Map()) {
  if (role === 'owner') return true
  const perms = permissionsOf(role, custom)
  return !!perms && perms.includes(permission)
}

// May a member with role `author` give `role` to someone whose role is
// `current` (null: not a member)? The owner gives any role but owner; others
// need `roles`, act only below their own rank, and give no permission they
// don't have.
function mayAssign (author, current, role, custom) {
  if (!can(author, 'roles', custom) || role === 'owner' || current === 'owner') return false
  const perms = permissionsOf(role, custom)
  if (!perms) return false
  if (author === 'owner') return true
  if (current && rankOf(current) >= rankOf(author)) return false
  if (rankOf(role) >= rankOf(author)) return false
  return grantable(author, perms, custom)
}

// Hypergraph's own permissions can only be handed on by who holds them; an
// app's own (e.g. 'edit-pages') by anyone with `roles`.
const OWN = ['decide', 'moderate', 'invite', 'roles']
function grantable (author, perms, custom) {
  if (author === 'owner') return true
  const mine = permissionsOf(author, custom) || []
  return perms.every((p) => !OWN.includes(p) || mine.includes(p))
}

// May a member with role `maker` invite people to `role` (research R16)?
// It needs `invite`; never owner; below its own rank, except member and
// guest (a member who may invite brings in members), and its own role if
// that role has no power over others (friends invite friends, who invite
// theirs; nobody mints moderators or admins); only permissions it holds; the
// owner invites to anything but owner.
const POWER = ['decide', 'moderate', 'roles']
function mayInvite (maker, role, custom) {
  if (!can(maker, 'invite', custom) || role === 'owner') return false
  const perms = permissionsOf(role, custom)
  if (!perms) return false
  if (maker === 'owner') return true
  const peer = role === maker && !perms.some((p) => POWER.includes(p))
  if (rankOf(role) >= rankOf(maker) && role !== 'member' && role !== 'guest' && !peer) return false
  return grantable(maker, perms, custom)
}

// May `author` take `target` out (remove or ban)?
function mayRemove (author, target, permission, custom) {
  if (!can(author, permission, custom) || target === 'owner') return false
  return !target || author === 'owner' || rankOf(target) < rankOf(author)
}

class State {
  constructor () {
    this.meta = null
    this.members = new Map() // identity hex -> { role, by, stamp, writer }
    this.writers = new Map() // writer key hex -> identity hex
    this.writerInfo = new Map() // writer key hex -> { identity, device, indexer } (research.md A8)
    this.gone = new Set() // `${identity hex}:${device hex}`: devices removed from the decision log
    this.revoked = new Map() // invite id hex -> { by, stamp }
    this.redeemed = new Map() // `${invite id hex}:${identity hex}` -> { at, by }
    this.uses = new Map() // invite id hex -> count
    this.cuts = new Map() // identity hex -> { log hex: length } (research.md A4)
    this.admits = new Map() // identity hex -> the code of the decision that let them back in after their cut (story 9)
    this.editcuts = new Map() // identity hex -> { permission: { log hex: length } } (research.md A9)
    this.roles = new Map() // custom role -> permissions
    this.banned = new Map() // identity hex -> { by, reason, stamp }
    this.moderated = new Map() // record id hex -> { flagged, hidden, removed }
    this.epochs = null // a private space's keys: { current, commits: { epoch: commit hex } } (story 8)
    this.subspaces = new Map() // sub-space key hex -> { name, private, writeRoles, parent (hex | null), by, stamp }
    this.listed = new Map() // log hex -> its space hex (spec 013: logs/list)
    this.scoped = new Map() // sub-space key hex -> a State of its own entries (sub:<key>:…)
    this._subs = new Map() // effective states, made on first use
  }

  static from (entries) {
    const state = new State()
    const scoped = new Map()
    for (const [key, value] of entries) {
      if (key.startsWith('sub:')) {
        const scope = key.slice(4, 68)
        if (!scoped.has(scope)) scoped.set(scope, [])
        scoped.get(scope).push([key.slice(69), value])
      } else if (key.startsWith('subspace:')) state.subspaces.set(key.slice(9), value)
      else if (key === 'epochs') state.epochs = value
      else if (key === 'meta') state.meta = value
      else if (key.startsWith('member:')) state.members.set(key.slice(7), value)
      else if (key.startsWith('writer:')) {
        state.writers.set(key.slice(7), value.identity)
        state.writerInfo.set(key.slice(7), value)
      } else if (key.startsWith('gone:')) state.gone.add(key.slice(5))
      else if (key.startsWith('revoked:')) state.revoked.set(key.slice(8), value)
      else if (key.startsWith('redeemed:')) state.redeemed.set(key.slice(9), value)
      else if (key.startsWith('uses:')) state.uses.set(key.slice(5), value.count)
      else if (key.startsWith('cut:')) state.cuts.set(key.slice(4), value.logs)
      else if (key.startsWith('admit:')) state.admits.set(key.slice(6), value.code)
      else if (key.startsWith('editcut:')) state.editcuts.set(key.slice(8), value.perms)
      else if (key.startsWith('role:')) state.roles.set(key.slice(5), value.permissions)
      else if (key.startsWith('banned:')) state.banned.set(key.slice(7), value)
      else if (key.startsWith('mod:')) state.moderated.set(key.slice(4), value)
      else if (key.startsWith('listed:')) state.listed.set(key.slice(7), value.space)
    }
    for (const [scope, list] of scoped) state.scoped.set(scope, State.from(list))
    return state
  }

  // The state of a sub-space (key: hex or bytes) as it counts: its parent's
  // members and roles, then its own (story 8, research.md A13); null if it
  // isn't one of this space's.
  sub (key) {
    const h = toHex(key)
    if (!this.subspaces.has(h)) return null
    if (!this._subs.has(h)) this._subs.set(h, new SubState(this, h))
    return this._subs.get(h)
  }

  // Is this a private space (its content readable only with its keys)?
  get private () { return !!(this.meta && this.meta.private) }

  // A private space's keys: { current epoch, commits: { epoch: commitment
  // hex } }, or null before the first.
  get keys () { return this.epochs }

  get name () { return this.meta ? this.meta.name : null }
  get owner () { return this.meta ? this.meta.owner : null }
  get policy () { return (this.meta && this.meta.policy) || 'auto' }
  // The ids of the app rules the space runs (sorted), or null if it never
  // recorded any.
  get rules () { return (this.meta && this.meta.rules) || null }
  // An open space's write limit (story 9): { records, periodMs } or null.
  get writeLimit () { return (this.meta && this.meta.writeLimit) || null }
  // A private space's history (A16): 'visible' (every member reads it) or 'hidden'.
  get history () { return (this.meta && this.meta.history) || 'visible' }
  // The helpers keeping the space (spec 013): hex keys, [] for none.
  get helpers () { return (this.meta && this.meta.helpers) || [] }

  isMember (identity) {
    return this.members.has(toHex(identity))
  }

  isBanned (identity) {
    return this.banned.has(toHex(identity))
  }

  isRevoked (inviteId) {
    return this.revoked.has(toHex(inviteId))
  }

  // Why a redemption of `inv` by `identity` would be refused here, at time
  // `now` (a code), or null: the checks apply makes when recording it.
  inviteRefusal (inv, identity, now) {
    const id = toHex(inv.id)
    const who = toHex(identity)
    if (this.redeemed.has(`${id}:${who}`)) return null
    if (inv.expires && now > inv.expires) return 'INVITE_EXPIRED'
    if (this.revoked.has(id)) return 'INVITE_REVOKED'
    if (inv.uses && (this.uses.get(id) || 0) >= inv.uses) return 'INVITE_USED_UP'
    if (this.banned.has(who) || !mayInvite(this.roleOf(inv.maker), inv.role, this.roles)) return 'NOT_ALLOWED'
    return null
  }

  // A device the identity removed (research.md A8): its writer keys count for
  // nothing here, and it can't claim new ones.
  isGone (identity, device) {
    return this.gone.has(toHex(identity) + ':' + toHex(device))
  }

  // May this identity's devices write decisions (decide or moderate), in
  // the space or one of its sub-spaces?
  writesDecisions (identity) {
    if (this.can(identity, 'decide') || this.can(identity, 'moderate')) return true
    for (const h of this.subspaces.keys()) {
      const sub = this.sub(h)
      if (sub.can(identity, 'decide') || sub.can(identity, 'moderate')) return true
    }
    return false
  }

  // { identity, device, indexer } of a decision-log writer key, or null.
  writer (key) {
    return this.writerInfo.get(toHex(key)) || null
  }

  // The writer keys of one device of an identity.
  writersOfDevice (identity, device) {
    const id = toHex(identity)
    const dev = toHex(device)
    return [...this.writerInfo].filter(([, w]) => w.identity === id && w.device === dev).map(([k]) => k)
  }

  roleOf (identity) {
    const m = this.members.get(toHex(identity))
    return m ? m.role : null
  }

  permissionsOf (role) {
    return permissionsOf(role, this.roles)
  }

  can (identity, permission) {
    return can(this.roleOf(identity), permission, this.roles)
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

  // How much of an identity's device log counts for an app permission (e.g.
  // editing a page, research.md A9): the cut recorded when it lost the
  // permission; otherwise everything while it holds it, nothing if not.
  editLimit (identity, permission, logKey) {
    const perms = this.editcuts.get(toHex(identity))
    const length = perms && perms[permission] ? perms[permission][toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.can(identity, permission) ? Infinity : 0
  }

  // Does a cut of an app permission it holds now name this log? Then its
  // edits there stopped counting for good: it writes in a new log.
  isEditCut (identity, logKey) {
    const perms = this.editcuts.get(toHex(identity))
    if (!perms) return false
    return Object.keys(perms).some((p) => perms[p][toHex(logKey)] !== undefined && this.can(identity, p))
  }

  isCut (identity, logKey) {
    const cut = this.cuts.get(toHex(identity))
    return !!cut && cut[toHex(logKey)] !== undefined
  }

  // Must this log of `identity` carry its admission code (story 9)? Yes for
  // someone cut before, in a log no cut names (made after the cut).
  mustAdmit (identity, logKey) {
    return this.cuts.has(toHex(identity)) && !this.isCut(identity, logKey)
  }

  // The code of the decision that let `identity` back in after its latest
  // cut (hex), or null.
  admission (identity) {
    return this.admits.get(toHex(identity)) || null
  }

  // { flagged, hidden, removed } of a record (by id).
  moderation (id) {
    return this.moderated.get(toHex(id)) || { flagged: false, hidden: false, removed: false }
  }

  isRemoved (id) {
    const m = this.moderated.get(toHex(id))
    return !!m && m.removed
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
      cuts: [...this.cuts].sort(),
      roles: [...this.roles].sort(),
      banned: [...this.banned].sort(),
      moderated: [...this.moderated].sort()
    }
  }
}

// A sub-space's state as it counts (story 8, research.md A13), read-only,
// with State's interface: the parent's members and roles (for a private one,
// only the parent's owner and admins), then its own entries (guests, role
// overrides); nobody banned in it or above is a member; cuts are the union of
// its own and the ones above (the lowest length per log); moderation, invites,
// epochs and settings are its own. Decision writers are the top space's.
class SubState {
  constructor (root, key) {
    const info = root.subspaces.get(key)
    const parent = info.parent ? root.sub(info.parent) : root
    const own = root.scoped.get(key) || new State()
    this.root = root
    this.key = key
    this.info = info
    this.own = own
    const ownMeta = own.meta || {}
    this.meta = parent.meta ? { ...parent.meta, name: info.name, private: info.private, parent: info.parent, policy: ownMeta.policy || parent.policy, rules: ownMeta.rules || parent.rules, writeLimit: ownMeta.writeLimit || null, history: ownMeta.history || 'visible' } : null
    this.roles = root.roles
    this.writers = root.writers
    this.writerInfo = root.writerInfo
    this.gone = root.gone
    this.revoked = own.revoked
    this.redeemed = own.redeemed
    this.uses = own.uses
    this.moderated = own.moderated
    this.epochs = own.epochs
    this.subspaces = root.subspaces
    this.listed = root.listed
    this.banned = new Map([...parent.banned, ...own.banned])
    this.members = new Map()
    for (const [id, m] of parent.members) {
      if (this.banned.has(id)) continue
      if (info.private && m.role !== 'owner' && m.role !== 'admin') continue
      this.members.set(id, m)
    }
    for (const [id, m] of own.members) if (!this.banned.has(id)) this.members.set(id, m)
    this.cuts = mergeCuts(parent.cuts, own.cuts)
    this.admits = new Map([...parent.admits, ...own.admits])
    this.editcuts = new Map(parent.editcuts)
    for (const [id, perms] of own.editcuts) {
      const merged = { ...(this.editcuts.get(id) || {}) }
      for (const [p, logs] of Object.entries(perms)) merged[p] = lowest(merged[p] || {}, logs)
      this.editcuts.set(id, merged)
    }
  }

  get name () { return this.info.name }
  get owner () { return this.root.owner }
  get policy () { return this.meta ? this.meta.policy : 'auto' }
  get rules () { return this.meta ? this.meta.rules : null }
  get writeLimit () { return this.meta ? this.meta.writeLimit : null }
  get history () { return this.meta ? this.meta.history : 'visible' }
  get helpers () { return (this.meta && this.meta.helpers) || [] } // the top space's
  get private () { return !!this.info.private }
  get keys () { return this.epochs }
  get writeRoles () { return this.info.writeRoles }
  get parent () { return this.info.parent }

  // May this identity write records here? Its role posts, and the sub-space
  // lets that role write (writeRoles; the owner and admins always may).
  canWrite (identity) {
    if (!this.can(identity, 'post')) return false
    const role = this.roleOf(identity)
    const only = this.info.writeRoles
    return !only.length || role === 'owner' || role === 'admin' || only.includes(role)
  }

  sub (key) { return this.root.sub(key) }
  writesDecisions (identity) { return this.root.writesDecisions(identity) }
}
for (const name of ['isMember', 'isBanned', 'isRevoked', 'inviteRefusal', 'isGone', 'writer', 'writersOfDevice', 'roleOf', 'permissionsOf', 'can', 'limitOf', 'editLimit', 'isEditCut', 'isCut', 'mustAdmit', 'admission', 'moderation', 'isRemoved', 'identityOfWriter']) {
  SubState.prototype[name] = State.prototype[name]
}

// Cuts of two scopes together: per identity, per log, the lowest length.
function mergeCuts (a, b) {
  const out = new Map(a)
  for (const [id, logs] of b) out.set(id, lowest(out.get(id) || {}, logs))
  return out
}

function lowest (a, b) {
  const out = { ...a }
  for (const [log, length] of Object.entries(b)) out[log] = log in out ? Math.min(out[log], length) : length
  return out
}

module.exports = { State, SubState, ROLES, RANK, ACTIONS, OWN, can, mayAssign, mayInvite, mayRemove, grantable, permissionsOf, rankOf, toHex }
