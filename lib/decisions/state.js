// A space's state, as the decision log's view holds it:
// name, owner, members and their roles, custom roles, which writer key speaks
// for which identity, invites used, cuts, bans and moderation of records.
// Kept from the view's changes, rebuilt from the whole view on open and when
// Autobase reorders it (lib/decisions/log.js).

const b4a = require('b4a')
const { MAX_MEMBERS } = require('../circles.js')

// Built-in roles and their permissions. `decide` lets a member
// record decisions (members, roles, invites), `moderate` moderation decisions;
// either makes the member's device a writer of the decision log.
/**
 * @typedef {import('../limit.js').WriteLimit} WriteLimit
 * @typedef {Uint8Array | string} KeyLike A key as bytes or hex.
 * @typedef {Map<string, string[]>} CustomRoles A space's own roles and their permissions.
 * @typedef {{ role: string, by: string, stamp: number }} Member
 * @typedef {{ identity: string, device: string, indexer: boolean }} WriterInfo
 * @typedef {{ flagged: boolean, hidden: boolean, removed: boolean }} Moderation
 * @typedef {{ by: string, reason: string, stamp: number }} Ban
 * @typedef {{ name: string, private: boolean, writeRoles: string[], parent: string | null, by: string, stamp: number }} SubspaceInfo
 * @typedef {{ space: string, top: string, cut: number, in: string }} Past A history log: the space and decision log its header names, where it counts up to, and which space reads it.
 * @typedef {{ by: string, stamp: number, hash: string, boxes: { to: string, sealed: string }[] }} Moved
 * @typedef {{ current: number, commits: Record<string, string>, others?: Record<string, number> }} Epochs A private space's keys: its current epoch, and each epoch's commitment (hex).
 * @typedef {{ epoch: number, logs: string[], stamp: number }} EpochLogs A secure epoch's writer logs (hex) and when it was decided.
 * @typedef {Record<string, number>} Cut Log hex -> the length that counts.
 *
 * A space's settings, as its decision log keeps them (`meta`).
 * @typedef {object} SpaceMeta
 * @property {string} name
 * @property {string} [owner]
 * @property {string} [policy]
 * @property {boolean} [private]
 * @property {number} [version]
 * @property {string | null} [parent]
 * @property {number} [stamp]
 * @property {boolean} [circle]
 * @property {string[] | null} [rules]
 * @property {string} [history]
 * @property {number} [disappearing] ms after which records go (a private space's), absent: off
 * @property {string[]} [helpers]
 * @property {boolean} [public]
 * @property {WriteLimit | null} [writeLimit]
 * @property {{ from: string, hash: string } | null} [renewed]
 * @property {number} [renewChunks]
 */

/**
 * What changed view keys touch (see touched()).
 * @typedef {{ all: boolean, ids: Set<string>, mods: Set<string>, listed: Set<string>, types: boolean }} Touched
 * @typedef {'isMember' | 'isRecorded' | 'isBanned' | 'isRevoked' | 'inviteRefusal' | 'isGone' | 'writer' | 'writersOfDevice' | 'roleOf' | 'permissionsOf' | 'can' | 'limitOf' | 'editLimit' | 'isEditCut' | 'isCut' | 'mustAdmit' | 'admission' | 'moderation' | 'isRemoved' | 'identityOfWriter'} Shared State's methods a SubState shares.
 * @typedef {SubState & Pick<State, Shared> & Partial<Omit<State, keyof SubState | Shared>>} SubView A sub-space's state, with State's methods (what only a top space has is absent).
 * @typedef {State | SubView} AnyState
 */
/** @type {Record<string, string[]>} */
const ROLES = {
  owner: ['decide', 'moderate', 'invite', 'roles', 'post'],
  admin: ['decide', 'moderate', 'invite', 'roles', 'post'],
  moderator: ['moderate', 'post'],
  member: ['post'],
  guest: ['post']
}
/** @type {Record<string, number>} */
const RANK = { owner: 5, admin: 4, moderator: 3, member: 2, guest: 1 }
const CUSTOM_RANK = 2 // a custom role ranks as a member
const ACTIONS = ['flag', 'hide', 'reveal', 'remove', 'ban', 'unban']

/** @param {KeyLike} k */
const toHex = (k) => (typeof k === 'string' ? k : b4a.toString(k, 'hex'))

/**
 * @param {string | null} role
 * @param {CustomRoles} custom
 * @returns {string[] | null}
 */
function permissionsOf (role, custom) {
  if (!role) return null
  if (ROLES[role]) return ROLES[role]
  return custom.get(role) || null
}

/**
 * @param {string | null} role
 */
function rankOf (role) {
  return RANK[/** @type {string} */ (role)] || CUSTOM_RANK // null: no rank, as a custom role
}

/**
 * @param {string | null} role
 * @param {string} permission
 * @param {CustomRoles} [custom]
 */
function can (role, permission, custom = new Map()) {
  if (role === 'owner') return true
  const perms = permissionsOf(role, custom)
  return !!perms && perms.includes(permission)
}

// May a member with role `author` give `role` to someone whose role is
// `current` (null: not a member)? The owner gives any role but owner; others
// need `roles`, act only below their own rank, and give no permission they
// don't have.
/**
 * @param {string | null} author
 * @param {string | null} current
 * @param {string} role
 * @param {CustomRoles} custom
 */
function mayAssign (author, current, role, custom) {
  if (!can(author, 'roles', custom) || role === 'owner' || current === 'owner') return false
  const perms = permissionsOf(role, custom)
  if (!perms) return false
  if (author === 'owner') return true
  if (current && rankOf(current) >= rankOf(/** @type {string} */ (author))) return false
  if (rankOf(role) >= rankOf(/** @type {string} */ (author))) return false
  return grantable(author, perms, custom)
}

// Hypergraph's own permissions can only be handed on by who holds them; an
// app's own (e.g. 'edit-pages') by anyone with `roles`.
const OWN = ['decide', 'moderate', 'invite', 'roles']
/**
 * @param {string | null} author
 * @param {string[]} perms
 * @param {CustomRoles} custom
 */
function grantable (author, perms, custom) {
  if (author === 'owner') return true
  const mine = permissionsOf(author, custom) || []
  return perms.every((p) => !OWN.includes(p) || mine.includes(p))
}

// May a member with role `maker` invite people to `role`?
// It needs `invite`; never owner; below its own rank, except member and
// guest (a member who may invite brings in members), and its own role if
// that role has no power over others (friends invite friends, who invite
// theirs; nobody mints moderators or admins); only permissions it holds; the
// owner invites to anything but owner.
const POWER = ['decide', 'moderate', 'roles']
/**
 * @param {string | null} maker
 * @param {string} role
 * @param {CustomRoles} custom
 */
function mayInvite (maker, role, custom) {
  if (!can(maker, 'invite', custom) || role === 'owner') return false
  const perms = permissionsOf(role, custom)
  if (!perms) return false
  if (maker === 'owner') return true
  const peer = role === maker && !perms.some((p) => POWER.includes(p))
  if (rankOf(role) >= rankOf(/** @type {string} */ (maker)) && role !== 'member' && role !== 'guest' && !peer) return false
  return grantable(maker, perms, custom)
}

/**
 * @param {string | null} author
 * @param {string | null} target
 * @param {string} permission
 * @param {CustomRoles} custom
 */
function mayRemove (author, target, permission, custom) {
  if (!can(author, permission, custom) || target === 'owner') return false
  return !target || author === 'owner' || rankOf(target) < rankOf(/** @type {string} */ (author))
}

// View key prefix -> [the State map it fills, the value's field it keeps (all
// of it if none)]; member:, listed:, writer: and gone: are kept their own way
// (State#apply). Not held: `redeemed:` and `uses:` (one per member when each
// has an invite of their own; read from the view when needed:
// lib/decisions/log.js entry, lib/space.js _redeem and redemptions).
/** @type {Record<string, [MapField, string?]>} */
const FIELDS = {
  'subspace:': ['subspaces'],
  'revoked:': ['revoked'],
  'cut:': ['cuts', 'logs'],
  'admit:': ['admits', 'code'],
  'editcut:': ['editcuts', 'perms'],
  'role:': ['roles', 'permissions'],
  'banned:': ['banned'],
  'mod:': ['moderated'],
  'past:': ['pasts'], // a renewed space's history logs
  'trim:': ['trims', 'below'], // where a log's history starts after a trim
  'keylogs:': ['keylogs'] // a secure epoch's writer logs
}

/**
 * @typedef {'subspaces' | 'revoked' | 'cuts' | 'admits' | 'editcuts' | 'roles' | 'banned' | 'moderated' | 'pasts' | 'trims' | 'keylogs'} MapField
 */
class State {
  constructor () {
    /** @type {SpaceMeta | null} */
    this.meta = null
    /** @type {Map<string, Member>} */
    this.members = new Map() // identity hex -> { role, by, stamp } (the view's entry also has the writer key, which only apply reads)
    /** @type {Map<string, string>} */
    this.writers = new Map() // writer key hex -> identity hex
    /** @type {Map<string, WriterInfo>} */
    this.writerInfo = new Map() // writer key hex -> { identity, device, indexer }
    /** @type {Set<string>} */
    this.gone = new Set() // `${identity hex}:${device hex}`: devices removed from the decision log
    /** @type {Map<string, { by: string, stamp: number }>} */
    this.revoked = new Map() // invite id hex -> { by, stamp }
    /** @type {Map<string, Cut>} */
    this.cuts = new Map() // identity hex -> { log hex: length }
    /** @type {Map<string, string>} */
    this.admits = new Map() // identity hex -> the code of the decision that let them back in after their cut
    /** @type {Map<string, Record<string, Cut>>} */
    this.editcuts = new Map() // identity hex -> { permission: { log hex: length } }
    /** @type {CustomRoles} */
    this.roles = new Map() // custom role -> permissions
    /** @type {Map<string, Ban>} */
    this.banned = new Map() // identity hex -> { by, reason, stamp }
    /** @type {Map<string, Moderation>} */
    this.moderated = new Map() // record id hex -> { flagged, hidden, removed }
    /** @type {Epochs | null} */
    this.epochs = null // a private space's keys: { current, commits: { epoch: commit hex } }
    /** @type {Map<string, EpochLogs>} */
    this.keylogs = new Map() // a secure epoch's commitment hex -> { epoch, logs (hex), stamp }
    /** @type {Map<string, SubspaceInfo>} */
    this.subspaces = new Map() // sub-space key hex -> { name, private, writeRoles, parent (hex | null), by, stamp }
    /** @type {Map<string, string>} */
    this.listed = new Map() // log hex -> its space hex (logs/list)
    /** @type {Map<string, Past>} */
    this.pasts = new Map() // log hex -> { space, top, cut, in } of a history log (the space and decision log its header names, where it counts up to, and which space of this one reads it)
    /** @type {Map<string, number>} */
    this.trims = new Map() // log hex -> the first block that still counts (history/trim)
    /** @type {Moved | null} */
    this.moved = null // { by, stamp, hash, boxes } once the space moved (space/moved)
    /** get() follows a set() @type {{ get (key: string): State } & Map<string, State>} */
    this.scoped = new Map() // sub-space key hex -> a State of its own entries (sub:<key>:…)
    /** @type {Map<string, SubView>} */
    this._subs = new Map() // effective states, made on first use
    /** @type {Map<string, string>} */
    this._strings = new Map() // the same string once (makers, roles, the space listed logs are of): memory per member
    this.typesVersion = 0 // the latest types version recorded (types/set), 0 for none
    /** @type {Map<number, string>} */
    this.typeVersions = new Map() // version -> its declaration, as recorded (JSON text)
    /** @type {[number, import('../types.js').StoredTypes] | null} */
    this._types = null // [version, the latest declaration parsed]
  }

  /**
   * @param {Iterable<[string, import('./apply.js').ViewNode['value']]>} entries
   * @returns {State}
   */
  static from (entries) {
    const state = new State()
    for (const [key, value] of entries) state.apply(key, value)
    return state
  }

  /**
   * @param {string} key
   * @param {import('./apply.js').ViewNode['value']} value A view entry's (null: deleted).
   */
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
    else if (key === 'moved') this.moved = value
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
      /** @type {Map<string, unknown>} */
      const map = this[field[0]]
      if (value === null) map.delete(key.slice(at))
      else map.set(key.slice(at), field[1] ? value[field[1]] : value)
    }
  }

  /**
   * @template T
   * @param {T} s
   * @returns {T}
   */
  #once (s) {
    if (typeof s !== 'string') return s
    if (!this._strings.has(s)) this._strings.set(s, s)
    return /** @type {T} */ (this._strings.get(s))
  }

  /**
   * @param {KeyLike} key
   * @returns {SubView | null}
   */
  sub (key) {
    const h = toHex(key)
    if (!this.subspaces.has(h)) return null
    if (!this._subs.has(h)) this._subs.set(h, /** @type {SubView} */ (new SubState(this, h)))
    return /** @type {SubView} */ (this._subs.get(h))
  }

  get private () { return !!(this.meta && this.meta.private) }
  get circle () { return !!(this.meta && this.meta.circle) }

  // A private space's keys: { current epoch, commits: { epoch: commitment
  // hex } }, or null before the first.
  get keys () { return this.epochs }

  get name () { return this.meta ? this.meta.name : null }
  get types () {
    const text = this.typeVersions.get(this.typesVersion)
    if (!text) return null
    if (!this._types || this._types[0] !== this.typesVersion) this._types = [this.typesVersion, JSON.parse(text)]
    return this._types[1]
  }

  get owner () { return this.meta ? this.meta.owner : null }
  get policy () { return (this.meta && this.meta.policy) || 'auto' }
  get rules () { return (this.meta && this.meta.rules) || null }
  get writeLimit () { return (this.meta && this.meta.writeLimit) || null }
  get history () { return (this.meta && this.meta.history) || 'visible' }
  get disappearing () { return (this.meta && this.meta.disappearing) || 0 }
  get helpers () { return (this.meta && this.meta.helpers) || [] }
  get public () { return !!(this.meta && this.meta.public) }
  get renewed () { return (this.meta && this.meta.renewed) || null }

  // One identity's entries (hex): a SubState works them out from its parent's
  // and its own instead of copying every member.
  /** @param {string} h */
  _member (h) { return this.members.get(h) }
  /** @param {string} h */
  _banned (h) { return this.banned.has(h) }
  /** @param {string} h */
  _cut (h) { return this.cuts.get(h) }
  /** @param {string} h */
  _admit (h) { return this.admits.get(h) }
  /** @param {string} h */
  _editcut (h) { return this.editcuts.get(h) }

  /**
   * @param {KeyLike} identity
   */
  isMember (identity) {
    return !!this.roleOf(identity)
  }

  /**
   * @param {KeyLike} identity
   */
  isRecorded (identity) {
    return !!this._member(toHex(identity))
  }

  /**
   * @param {KeyLike} identity
   */
  isBanned (identity) {
    return this._banned(toHex(identity))
  }

  /**
   * @param {KeyLike} inviteId
   */
  isRevoked (inviteId) {
    return this.revoked.has(toHex(inviteId))
  }

  // Why a redemption of `inv` by `identity` would be refused here, at time
  // `now` (a code), or null: the checks apply makes when recording it.
  // `used`: how many people redeemed it (the view's `uses:`). One recorded
  // already (`redeemed:`) is never refused: the caller looks first (lib/space.js
  // _redeem).
  /**
   * @param {import('../encodings.js').Invite} inv
   * @param {KeyLike} identity
   * @param {number} now
   * @param {number} [used]
   * @returns {import('../errors.js').ErrorCode | null}
   */
  inviteRefusal (inv, identity, now, used = 0) {
    const id = toHex(inv.id)
    const who = toHex(identity)
    if (inv.expires && now > inv.expires) return 'INVITE_EXPIRED'
    if (this.revoked.has(id)) return 'INVITE_REVOKED'
    if (inv.uses && used >= inv.uses) return 'INVITE_USED_UP'
    if (this._banned(who) || !mayInvite(this.roleOf(inv.maker), inv.role, this.roles)) return 'NOT_ALLOWED'
    if (this.circle) { // the checks apply makes
      const maker = this.roleOf(inv.maker)
      if (maker !== 'owner' && maker !== 'admin') return 'NOT_ALLOWED'
      if (!this.members.has(who) && this.members.size >= MAX_MEMBERS) return 'CIRCLE_FULL'
    }
    return null
  }

  /**
   * @param {KeyLike} identity
   * @param {KeyLike} device
   */
  isGone (identity, device) {
    return this.gone.has(toHex(identity) + ':' + toHex(device))
  }

  /**
   * @param {KeyLike} identity
   * @returns {boolean}
   */
  writesDecisions (identity) {
    if (this.can(identity, 'decide') || this.can(identity, 'moderate')) return true
    for (const h of this.subspaces.keys()) {
      const sub = this.sub(h)
      if (/** @type {SubView} */ (sub).can(identity, 'decide') || /** @type {SubView} */ (sub).can(identity, 'moderate')) return true
    }
    return false
  }

  /**
   * @param {KeyLike} key
   */
  writer (key) {
    return this.writerInfo.get(toHex(key)) || null
  }

  /**
   * @param {KeyLike} identity
   * @param {KeyLike} device
   */
  writersOfDevice (identity, device) {
    const id = toHex(identity)
    const dev = toHex(device)
    return [...this.writerInfo].filter(([, w]) => w.identity === id && w.device === dev).map(([k]) => k)
  }

  // The recorded role; in a public space, anyone else not banned
  // is a member.
  /**
   * @param {KeyLike} identity
   * @returns {string | null}
   */
  roleOf (identity) {
    const h = toHex(identity)
    const m = this._member(h)
    if (m) return m.role
    return this.public && !this._banned(h) ? 'member' : null
  }

  /**
   * @param {string | null} role
   */
  permissionsOf (role) {
    return permissionsOf(role, this.roles)
  }

  /**
   * @param {KeyLike} identity
   * @param {string} permission
   * @returns {boolean}
   */
  can (identity, permission) {
    return can(this.roleOf(identity), permission, this.roles)
  }

  /**
   * @param {KeyLike} identity
   * @returns {boolean}
   */
  canWrite (identity) {
    return this.can(identity, 'post')
  }

  // How much of an identity's device log counts: records below the limit are
  // kept, the rest ignored. A cut, once recorded for a log, stays its limit
  // for good; otherwise everything if the identity may write, nothing if not.
  /**
   * @param {KeyLike} identity
   * @param {KeyLike} logKey
   * @returns {number}
   */
  limitOf (identity, logKey) {
    const cut = this._cut(toHex(identity))
    const length = cut ? cut[toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.canWrite(identity) ? Infinity : 0
  }

  // How much of an identity's device log counts for an app permission (e.g.
  // editing a page): the cut recorded when it lost the
  // permission; otherwise everything while it holds it, nothing if not.
  /**
   * @param {KeyLike} identity
   * @param {string} permission
   * @param {KeyLike} logKey
   * @returns {number}
   */
  editLimit (identity, permission, logKey) {
    const perms = this._editcut(toHex(identity))
    const length = perms && perms[permission] ? perms[permission][toHex(logKey)] : undefined
    if (length !== undefined) return length
    return this.can(identity, permission) ? Infinity : 0
  }

  // Does a cut of an app permission it holds now name this log? Then its
  // edits there stopped counting for good: it writes in a new log.
  /**
   * @param {KeyLike} identity
   * @param {KeyLike} logKey
   */
  isEditCut (identity, logKey) {
    const perms = this._editcut(toHex(identity))
    if (!perms) return false
    return Object.keys(perms).some((p) => perms[p][toHex(logKey)] !== undefined && this.can(identity, p))
  }

  /**
   * @param {KeyLike} identity
   * @param {KeyLike} logKey
   */
  isCut (identity, logKey) {
    const cut = this._cut(toHex(identity))
    return !!cut && cut[toHex(logKey)] !== undefined
  }

  // Must this log of `identity` carry its admission code? Yes for
  // someone cut before, in a log no cut names (made after the cut).
  // Not for a public space's fallback members: it lets anyone back in.
  /**
   * @param {KeyLike} identity
   * @param {KeyLike} logKey
   */
  mustAdmit (identity, logKey) {
    const h = toHex(identity)
    if (!this._member(h) && this.public) return false
    return !!this._cut(h) && !this.isCut(identity, logKey)
  }

  /**
   * @param {KeyLike} identity
   * @returns {string | null}
   */
  admission (identity) {
    return this._admit(toHex(identity)) || null
  }

  /**
   * @param {KeyLike} id
   * @returns {Moderation}
   */
  moderation (id) {
    return this.moderated.get(toHex(id)) || { flagged: false, hidden: false, removed: false }
  }

  /**
   * @param {KeyLike} id
   */
  isRemoved (id) {
    const m = this.moderated.get(toHex(id))
    return !!m && m.removed
  }

  /**
   * @param {KeyLike} writerKey
   * @returns {string | null}
   */
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

// A sub-space's state as it counts, read-only,
// with State's interface: the parent's members and roles (for a private one,
// only the parent's owner and admins), then its own entries (guests, role
// overrides); nobody banned in it or above is a member; cuts are the union of
// its own and the ones above (the lowest length per log); moderation, invites,
// epochs and settings are its own. Decision writers are the top space's.
// Made again after each change of the state, so it copies nothing per member:
// one identity's entries are worked out when asked (_member, _cut...), the
// whole maps (members, banned, cuts, admits, editcuts) only when read.
class SubState {
  /**
   * @param {State} root
   * @param {string} key A sub-space's key, hex.
   */
  constructor (root, key) {
    const info = /** @type {SubspaceInfo} */ (root.subspaces.get(key))
    const parent = info.parent ? /** @type {SubView} */ (root.sub(info.parent)) : root
    const own = root.scoped.get(key) || new State()
    this.root = root
    this.key = key
    this.info = info
    /** @type {AnyState} */
    this.up = parent
    this.own = own
    /** @type {Partial<SpaceMeta>} */
    const ownMeta = own.meta || {}
    /** @type {(SpaceMeta & { policy: string, history: string, rules: string[] | null }) | null} */
    this.meta = parent.meta ? { ...parent.meta, name: info.name, private: info.private, parent: info.parent, policy: ownMeta.policy || parent.policy, rules: ownMeta.rules || parent.rules, writeLimit: ownMeta.writeLimit || null, history: ownMeta.history || 'visible', disappearing: ownMeta.disappearing || 0, public: !!ownMeta.public } : null
    this.roles = root.roles
    this.writers = root.writers
    this.writerInfo = root.writerInfo
    this.gone = root.gone
    this.revoked = own.revoked
    this.moderated = own.moderated
    this.epochs = own.epochs
    this.keylogs = own.keylogs
    this.subspaces = root.subspaces
    this.listed = root.listed
    this.pasts = root.pasts // the top space's (each names the space reading it)
    this.trims = root.trims
    this.moved = root.moved
    /** @type {Record<string, Map<string, any>>} */
    this._maps = {}
  }

  /** @param {string} h @returns {boolean} */
  _banned (h) { return this.own.banned.has(h) || this.up._banned(h) }

  /**
   * @param {string} h
   * @returns {Member | undefined}
   */
  _member (h) {
    if (this._banned(h)) return undefined
    const m = this.own.members.get(h)
    if (m) return m
    const up = this.up._member(h)
    return up && (!this.info.private || up.role === 'owner' || up.role === 'admin') ? up : undefined
  }

  /**
   * @param {string} h
   * @returns {Cut | undefined}
   */
  _cut (h) {
    const up = this.up._cut(h)
    const mine = this.own.cuts.get(h)
    return mine ? lowest(up || {}, mine) : up
  }

  /** @param {string} h @returns {string | undefined} */
  _admit (h) { return this.own.admits.has(h) ? this.own.admits.get(h) : this.up._admit(h) }

  /**
   * @param {string} h
   * @returns {Record<string, Cut> | undefined}
   */
  _editcut (h) {
    const up = this.up._editcut(h)
    const mine = this.own.editcuts.get(h)
    if (!mine) return up
    const merged = { ...(up || {}) }
    for (const [p, logs] of Object.entries(mine)) merged[p] = lowest(merged[p] || {}, logs)
    return merged
  }

  /**
   * @template V
   * @param {'members' | 'banned' | 'cuts' | 'admits' | 'editcuts'} name
   * @param {(h: string) => V | undefined} get
   * @returns {Map<string, V>}
   */
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
  /** @type {Map<string, Ban>} */
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
  get disappearing () { return (this.meta && this.meta.disappearing) || 0 }
  get helpers () { return (this.meta && this.meta.helpers) || [] } // the top space's
  get private () { return !!this.info.private }
  get public () { return !!(this.meta && this.meta.public) } // its own, not its parent's
  get keys () { return this.epochs }
  get writeRoles () { return this.info.writeRoles }
  get renewed () { return this.root.renewed }
  get parent () { return this.info.parent }

  /**
   * @param {KeyLike} identity
   * @returns {boolean}
   */
  canWrite (identity) {
    if (!/** @type {SubView} */ (/** @type {unknown} */ (this)).can(identity, 'post')) return false
    const role = /** @type {SubView} */ (/** @type {unknown} */ (this)).roleOf(identity)
    /** @type {(string | null)[]} */
    const only = this.info.writeRoles
    return !only.length || role === 'owner' || role === 'admin' || only.includes(role)
  }

  /** @param {KeyLike} key */
  sub (key) { return this.root.sub(key) }
  /** @param {KeyLike} identity */
  writesDecisions (identity) { return this.root.writesDecisions(identity) }
}
for (const name of ['isMember', 'isRecorded', 'isBanned', 'isRevoked', 'inviteRefusal', 'isGone', 'writer', 'writersOfDevice', 'roleOf', 'permissionsOf', 'can', 'limitOf', 'editLimit', 'isEditCut', 'isCut', 'mustAdmit', 'admission', 'moderation', 'isRemoved', 'identityOfWriter']) {
  /** @type {any} */ (SubState.prototype)[name] = /** @type {any} */ (State.prototype)[name] // copies State's methods
}

/**
 * @param {Cut} a
 * @param {Cut} b
 * @returns {Cut}
 */
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
const QUIET = new Set(['redeemed:', 'uses:', 'revoked:', 'writer:', 'writers:', 'gone:', 'keylogs:'])
/**
 * @param {Iterable<string> | null} keys
 * @returns {Touched}
 */
function touched (keys) {
  const out = { all: !keys, ids: new Set(), mods: new Set(), listed: new Set(), types: !keys }
  for (let key of keys || []) {
    if (key === 'types') out.types = true // the space's types changed
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
