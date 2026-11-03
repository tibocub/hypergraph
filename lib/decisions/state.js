// A space's state, as the decision log's view holds it (data-model.md):
// name, owner, members and their roles, custom roles, which writer key speaks
// for which identity, invites used, cuts, bans and moderation of records.
// Kept from the view's changes, rebuilt from the whole view on open and when
// Autobase reorders it (lib/decisions/log.js).

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

// View key prefix -> [the State map it fills, the value's field it keeps (all
// of it if none)]; member:, listed:, writer: and gone: are kept their own way
// (State#apply). Not held: `redeemed:` and `uses:` (one per member when each
// has an invite of their own; read from the view when needed:
// lib/decisions/log.js entry, lib/space.js _redeem and redemptions).
const FIELDS = {
  'subspace:': ['subspaces'],
  'revoked:': ['revoked'],
  'cut:': ['cuts', 'logs'],
  'admit:': ['admits', 'code'],
  'editcut:': ['editcuts', 'perms'],
  'role:': ['roles', 'permissions'],
  'banned:': ['banned'],
  'mod:': ['moderated']
}

class State {
  constructor () {
    this.meta = null
    this.members = new Map() // identity hex -> { role, by, stamp } (the view's entry also has the writer key, which only apply reads)
    this.writers = new Map() // writer key hex -> identity hex
    this.writerInfo = new Map() // writer key hex -> { identity, device, indexer } (research.md A8)
    this.gone = new Set() // `${identity hex}:${device hex}`: devices removed from the decision log
    this.revoked = new Map() // invite id hex -> { by, stamp }
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
    this._strings = new Map() // the same string once (makers, roles, the space listed logs are of): memory per member
    this.typesVersion = 0 // spec 015: the latest types version recorded (types/set), 0 for none
    this.typeVersions = new Map() // version -> its declaration, as recorded (JSON text)
    this._types = null // [version, the latest declaration parsed]
  }

  static from (entries) {
    const state = new State()
    for (const [key, value] of entries) state.apply(key, value)
    return state
  }

  // One entry of the view, put (`value`) or deleted (null), applied in place
  // (lib/decisions/log.js keeps the state this way between rebuilds).
  apply (key, value) {
    this._subs.clear()
    if (key.startsWith('sub:')) {
      const scope = key.slice(4, 68)
      if (!this.scoped.has(scope)) this.scoped.set(scope, new State())
      this.scoped.get(scope).apply(key.slice(69), value)
      return
    }
    if (key === 'meta') this.meta = value
    else if (key === 'epochs') this.epochs = value
    else if (key === 'types') this.typesVersion = value ? value.version : 0
    else if (key.startsWith('types:')) {
      if (value === null) this.typeVersions.delete(Number(key.slice(6)))
      else this.typeVersions.set(Number(key.slice(6)), value)
    } else if (key.startsWith('writer:')) {
      const k = key.slice(7)
      if (value === null) {
        this.writers.delete(k)
        this.writerInfo.delete(k)
      } else {
        this.writers.set(k, value.identity)
        this.writerInfo.set(k, value)
      }
    } else if (key.startsWith('member:')) {
      if (value === null) this.members.delete(key.slice(7))
      else this.members.set(key.slice(7), { role: this.#once(value.role), by: this.#once(value.by), stamp: value.stamp })
    } else if (key.startsWith('listed:')) {
      if (value === null) this.listed.delete(key.slice(7))
      else this.listed.set(key.slice(7), this.#once(value.space))
    } else if (key.startsWith('gone:')) {
      if (value === null) this.gone.delete(key.slice(5))
      else this.gone.add(key.slice(5))
    } else {
      const at = key.indexOf(':') + 1
      const field = at && FIELDS[key.slice(0, at)]
      if (!field) return
      const map = this[field[0]]
      if (value === null) map.delete(key.slice(at))
      else map.set(key.slice(at), field[1] ? value[field[1]] : value)
    }
  }

  #once (s) {
    if (typeof s !== 'string') return s
    if (!this._strings.has(s)) this._strings.set(s, s)
    return this._strings.get(s)
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
  // spec 015: the space's record types (Types#describe() form), the latest
  // recorded; null for a space from before (the app's own are used)
  get types () {
    const text = this.typeVersions.get(this.typesVersion)
    if (!text) return null
    if (!this._types || this._types[0] !== this.typesVersion) this._types = [this.typesVersion, JSON.parse(text)]
    return this._types[1]
  }

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
  // Made public (spec 016): anyone the decision log doesn't name is a member.
  get public () { return !!(this.meta && this.meta.public) }

  // One identity's entries (hex): a SubState works them out from its parent's
  // and its own instead of copying every member.
  _member (h) { return this.members.get(h) }
  _banned (h) { return this.banned.has(h) }
  _cut (h) { return this.cuts.get(h) }
  _admit (h) { return this.admits.get(h) }
  _editcut (h) { return this.editcuts.get(h) }

  isMember (identity) {
    return !!this.roleOf(identity)
  }

  // Named by a decision (not a public space's fallback member, spec 016)?
  isRecorded (identity) {
    return !!this._member(toHex(identity))
  }

  isBanned (identity) {
    return this._banned(toHex(identity))
  }

  isRevoked (inviteId) {
    return this.revoked.has(toHex(inviteId))
  }

  // Why a redemption of `inv` by `identity` would be refused here, at time
  // `now` (a code), or null: the checks apply makes when recording it.
  // `used`: how many people redeemed it (the view's `uses:`). One recorded
  // already (`redeemed:`) is never refused: the caller looks first (lib/space.js
  // _redeem).
  inviteRefusal (inv, identity, now, used = 0) {
    const id = toHex(inv.id)
    const who = toHex(identity)
    if (inv.expires && now > inv.expires) return 'INVITE_EXPIRED'
    if (this.revoked.has(id)) return 'INVITE_REVOKED'
    if (inv.uses && used >= inv.uses) return 'INVITE_USED_UP'
    if (this._banned(who) || !mayInvite(this.roleOf(inv.maker), inv.role, this.roles)) return 'NOT_ALLOWED'
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

  // The recorded role; in a public space (spec 016), anyone else not banned
  // is a member.
  roleOf (identity) {
    const h = toHex(identity)
    const m = this._member(h)
    if (m) return m.role
    return this.public && !this._banned(h) ? 'member' : null
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
    const cut = this._cut(toHex(identity))
    const length = cut ? cut[toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.canWrite(identity) ? Infinity : 0
  }

  // How much of an identity's device log counts for an app permission (e.g.
  // editing a page, research.md A9): the cut recorded when it lost the
  // permission; otherwise everything while it holds it, nothing if not.
  editLimit (identity, permission, logKey) {
    const perms = this._editcut(toHex(identity))
    const length = perms && perms[permission] ? perms[permission][toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.can(identity, permission) ? Infinity : 0
  }

  // Does a cut of an app permission it holds now name this log? Then its
  // edits there stopped counting for good: it writes in a new log.
  isEditCut (identity, logKey) {
    const perms = this._editcut(toHex(identity))
    if (!perms) return false
    return Object.keys(perms).some((p) => perms[p][toHex(logKey)] !== undefined && this.can(identity, p))
  }

  isCut (identity, logKey) {
    const cut = this._cut(toHex(identity))
    return !!cut && cut[toHex(logKey)] !== undefined
  }

  // Must this log of `identity` carry its admission code (story 9)? Yes for
  // someone cut before, in a log no cut names (made after the cut).
  // Not for a public space's fallback members: it lets anyone back in.
  mustAdmit (identity, logKey) {
    const h = toHex(identity)
    if (!this._member(h) && this.public) return false
    return !!this._cut(h) && !this.isCut(identity, logKey)
  }

  // The code of the decision that let `identity` back in after its latest
  // cut (hex), or null.
  admission (identity) {
    return this._admit(toHex(identity)) || null
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
// Made again after each change of the state, so it copies nothing per member:
// one identity's entries are worked out when asked (_member, _cut...), the
// whole maps (members, banned, cuts, admits, editcuts) only when read.
class SubState {
  constructor (root, key) {
    const info = root.subspaces.get(key)
    const parent = info.parent ? root.sub(info.parent) : root
    const own = root.scoped.get(key) || new State()
    this.root = root
    this.key = key
    this.info = info
    this.up = parent
    this.own = own
    const ownMeta = own.meta || {}
    this.meta = parent.meta ? { ...parent.meta, name: info.name, private: info.private, parent: info.parent, policy: ownMeta.policy || parent.policy, rules: ownMeta.rules || parent.rules, writeLimit: ownMeta.writeLimit || null, history: ownMeta.history || 'visible', public: !!ownMeta.public } : null
    this.roles = root.roles
    this.writers = root.writers
    this.writerInfo = root.writerInfo
    this.gone = root.gone
    this.revoked = own.revoked
    this.moderated = own.moderated
    this.epochs = own.epochs
    this.subspaces = root.subspaces
    this.listed = root.listed
    this._maps = {}
  }

  _banned (h) { return this.own.banned.has(h) || this.up._banned(h) }

  _member (h) {
    if (this._banned(h)) return undefined
    const m = this.own.members.get(h)
    if (m) return m
    const up = this.up._member(h)
    return up && (!this.info.private || up.role === 'owner' || up.role === 'admin') ? up : undefined
  }

  _cut (h) {
    const up = this.up._cut(h)
    const mine = this.own.cuts.get(h)
    return mine ? lowest(up || {}, mine) : up
  }

  _admit (h) { return this.own.admits.has(h) ? this.own.admits.get(h) : this.up._admit(h) }

  _editcut (h) {
    const up = this.up._editcut(h)
    const mine = this.own.editcuts.get(h)
    if (!mine) return up
    const merged = { ...(up || {}) }
    for (const [p, logs] of Object.entries(mine)) merged[p] = lowest(merged[p] || {}, logs)
    return merged
  }

  // A whole map, made when first read: `get` of each id of the parent's and own maps.
  _map (name, get) {
    if (!this._maps[name]) {
      const out = new Map()
      for (const h of [...this.up[name].keys(), ...this.own[name].keys()]) {
        const v = get(h)
        if (v !== undefined) out.set(h, v)
      }
      this._maps[name] = out
    }
    return this._maps[name]
  }

  get members () { return this._map('members', (h) => this._member(h)) }
  get banned () { return this._map('banned', (h) => (this.own.banned.has(h) ? this.own.banned.get(h) : this.up.banned.get(h))) }
  get cuts () { return this._map('cuts', (h) => this._cut(h)) }
  get admits () { return this._map('admits', (h) => this._admit(h)) }
  get editcuts () { return this._map('editcuts', (h) => this._editcut(h)) }

  get name () { return this.info.name }
  get owner () { return this.root.owner }
  get policy () { return this.meta ? this.meta.policy : 'auto' }
  get rules () { return this.meta ? this.meta.rules : null }
  get writeLimit () { return this.meta ? this.meta.writeLimit : null }
  get history () { return this.meta ? this.meta.history : 'visible' }
  get helpers () { return (this.meta && this.meta.helpers) || [] } // the top space's
  get private () { return !!this.info.private }
  get public () { return !!(this.meta && this.meta.public) } // its own, not its parent's (spec 016)
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
for (const name of ['isMember', 'isRecorded', 'isBanned', 'isRevoked', 'inviteRefusal', 'isGone', 'writer', 'writersOfDevice', 'roleOf', 'permissionsOf', 'can', 'limitOf', 'editLimit', 'isEditCut', 'isCut', 'mustAdmit', 'admission', 'moderation', 'isRemoved', 'identityOfWriter']) {
  SubState.prototype[name] = State.prototype[name]
}

function lowest (a, b) {
  const out = { ...a }
  for (const [log, length] of Object.entries(b)) out[log] = log in out ? Math.min(out[log], length) : length
  return out
}

// What changed view keys (lib/decisions/log.js 'change'; null: a full read)
// touch, for what runs after a decision to look only there: { all, ids, mods,
// listed }: identities whose membership, role, ban or cuts moved (hex),
// moderated records, listed logs; `all` when anything else that decides who
// may write moved (settings, role definitions, sub-spaces). Invites used,
// writer keys, removed devices and keys touch none of these.
const IDS = new Set(['member:', 'banned:', 'cut:', 'admit:', 'editcut:'])
const QUIET = new Set(['redeemed:', 'uses:', 'revoked:', 'writer:', 'writers:', 'gone:'])
function touched (keys) {
  const out = { all: !keys, ids: new Set(), mods: new Set(), listed: new Set(), types: !keys }
  for (let key of keys || []) {
    if (key === 'types') out.types = true // spec 015: the space's types changed
    if (key.startsWith('sub:')) key = key.slice(69)
    const at = key.indexOf(':') + 1
    const prefix = key.slice(0, at)
    if (IDS.has(prefix)) out.ids.add(key.slice(at))
    else if (prefix === 'mod:') out.mods.add(key.slice(at))
    else if (prefix === 'listed:') out.listed.add(key.slice(at))
    else if (!QUIET.has(prefix) && key !== 'epochs') out.all = true
  }
  return out
}

module.exports = { State, SubState, touched, ROLES, RANK, ACTIONS, OWN, can, mayAssign, mayInvite, mayRemove, grantable, permissionsOf, rankOf, toHex }
