// Applying decisions (research R8), adapted from src/v2/control.js. Runs inside
// Autobase's apply, in the same order on every member, so it must be
// deterministic: it reads only the view and the decision itself, never the
// clock or the network. A decision counts only if its author held the
// permission at that point of the order; anything else, malformed included,
// is skipped.
//
// The view is a Hyperbee (keys: meta, member:<id>, writer:<key>, writers:<id>,
// gone:<id>:<device>, redeemed:<invite>:<id>, uses:<invite>, cut:<id>,
// role:<name>, banned:<id>, mod:<record id>, epochs; story 8: subspaces,
// subspace:<key>, and a sub-space's own entries under sub:<key>:…);
// lib/decisions/state.js reads it.
//
// Decision rights follow devices (research.md A8): the writers of the log are
// devices of members whose role has `decide` or `moderate` (a device claims
// its key with `writer/add`); a device removal signed by the identity key
// (`device/remove`) takes its keys away; one device per member with `decide`
// settles the order (an Autobase indexer).
//
// Sub-spaces (story 8, research.md A13): a sub-space's decisions are kept in
// its top space's decision log, as `scoped { space, decision }`, so they are
// in one order with the parent's. Inside one, a member's role is their own
// there, else their parent's (for a private sub-space only the owner's and
// admins'), and nobody banned in it or above has any; its own entries
// (members, bans, cuts, moderation, invites, epochs, settings) are kept
// under `sub:<key>:`.

const c = require('compact-encoding')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const enc = require('../encodings.js')
const { Identity } = require('../identity.js')
const { verifyInvite, verifyRedemption } = require('../invites.js')
const { ROLES, ACTIONS, OWN, can, permissionsOf, mayAssign, mayInvite, mayRemove, grantable, rankOf } = require('./state.js')
const { validLimit } = require('../limit.js')

const hex = (b) => b4a.toString(b, 'hex')
const NS_WRITER = b4a.from('hypergraph/writer\0')
const NS_REMOVE = b4a.from('hypergraph/device-remove\0')

// What a member signs to say "this writer key of the decision log is mine".
const writerSignable = (writerKey, space) => b4a.concat([NS_WRITER, writerKey, space])

// What the identity key signs to remove a device from a space (research.md
// A7): the same bytes are a record in an identity log and a decision here.
const removalSignable = (space, device, cut) => b4a.concat([NS_REMOVE, space, device, cut])

function initProof (identity, writerKey, space) {
  return identity.attest(writerSignable(writerKey, space))
}

const POLICIES = ['auto', 'everything'] // storage policies (research.md A10)

// What may be decided inside a sub-space (story 8).
const SCOPED = new Set(['member/remove', 'role/set', 'moderate', 'invite/redeem', 'invite/revoke', 'key/rotate', 'settings/set', 'subspace/create'])

// The prefix of a scope's own keys: '' for the top space.
const P = (scope) => (scope ? `sub:${scope}:` : '')

async function applyNodes (nodes, view, host, { space }) {
  for (const { value, from } of nodes) {
    let d = null
    try { d = c.decode(enc.decision, value) } catch { continue }
    const before = await view.get(`writer:${hex(from.key)}`)
    const counting = countWrites(view)
    let scope = null
    if (d.type === 'scoped') {
      scope = hex(d.space)
      try { d = c.decode(enc.decision, d.decision) } catch { continue }
      if (!SCOPED.has(d.type)) d = { ...d, ignored: true }
    }
    const chain = scope ? await chainOf(view, scope) : []
    // The decision's code (story 9): a log made after it carries it, if it
    // lets someone back in (admit()).
    if (!d.ignored && chain) await applyOne(d, from.key, counting, host, space, chain, hex(crypto.hash(b4a.concat([from.key, value]))))
    await listDecision(view, d, from.key, before ? before.value : null, counting.writes > 0, scope)
  }
}

// A sub-space and the sub-spaces above it, nearest first ([] for the top
// space), or null if it isn't one.
async function chainOf (view, scope) {
  const chain = []
  for (let s = scope; s; ) {
    const node = await view.get(`subspace:${s}`)
    if (!node || chain.includes(s)) return null
    chain.push(s)
    s = node.value.parent
  }
  return chain
}

// The sub-spaces of this space, with their parents: [{ key, parent, private }].
async function subspacesOf (view) {
  const node = await view.get('subspaces')
  const out = []
  for (const key of node ? node.value.keys : []) {
    const info = await view.get(`subspace:${key}`)
    if (info) out.push({ key, parent: info.value.parent, private: info.value.private })
  }
  return out
}

// Is `scope` (hex) below `top` (hex, or null: the top space)?
function below (subs, scope, top) {
  const byKey = new Map(subs.map((s) => [s.key, s]))
  for (let s = byKey.get(scope); s; s = byKey.get(s.parent)) if (s.parent === top) return true
  return false
}

// Someone's member entry as it counts in `chain` (nearest first; [] for the
// top space), or null: banned there or anywhere above, or not a member; in a
// private sub-space, the parent's members count only as owner or admin.
async function memberIn (view, chain, id) {
  for (const s of [...chain, null]) if (await view.get(`${P(s)}banned:${id}`)) return null
  const own = async (i) => {
    if (i === chain.length) {
      const node = await view.get(`member:${id}`)
      return node ? node.value : null
    }
    const node = await view.get(`${P(chain[i])}member:${id}`)
    if (node) return node.value
    const up = await own(i + 1)
    if (!up) return null
    const info = await view.get(`subspace:${chain[i]}`)
    if (info.value.private && up.role !== 'owner' && up.role !== 'admin') return null
    return up
  }
  return own(0)
}

async function bannedIn (view, chain, id) {
  for (const s of [...chain, null]) if (await view.get(`${P(s)}banned:${id}`)) return true
  return false
}

// The view, counting the writes a decision makes: it counted if it changed
// anything.
function countWrites (view) {
  const out = {
    writes: 0,
    get: (key) => view.get(key),
    put: (key, value) => { out.writes++; return view.put(key, value) },
    del: (key) => { out.writes++; return view.del(key) }
  }
  return out
}

// The decision list (space.decisions(), core follow-ups): every decision in
// the order applied, readable — who (the identity and device of its writer
// key then), what, when (the decider's stamp), why, and whether it counted.
// Kept in the view after every other key (`~log:`), so Autobase's reorders
// rewrite it like the rest, and every member lists the same once settled.
// `space`: the sub-space it was about (story 8), or none.
async function listDecision (view, d, writer, w, counted, scope = null) {
  const node = await view.get('~count')
  const seq = node ? node.value : 0
  const entry = { type: d.type, at: d.stamp, writer: hex(writer), by: w ? w.identity : null, device: w ? w.device : null, counted, ...details(d) }
  if (scope) entry.space = scope
  if (d.type === 'space/init' && counted) {
    const meta = await view.get('meta')
    entry.by = meta.value.owner
    const info = await view.get(`writer:${hex(writer)}`)
    entry.device = info ? info.value.device : null
  }
  await view.put(DECISION_KEY + String(seq).padStart(12, '0'), entry)
  await view.put('~count', seq + 1)
}

const DECISION_KEY = '~log:'

// What a decision says, readable (keys as hex; lib/space.js shows them as
// z32).
function details (d) {
  switch (d.type) {
    case 'space/init': return { name: d.name, policy: d.policy }
    case 'member/add': case 'member/remove': return { identity: hex(d.identity) }
    case 'role/define': return { name: d.name, permissions: d.permissions }
    case 'role/set': return { identity: hex(d.identity), role: d.role }
    case 'moderate': return { action: d.action, target: hex(d.target), reason: d.reason }
    case 'invite/redeem': {
      try {
        const r = c.decode(enc.redemption, d.redemption)
        return { identity: hex(r.identity), role: r.invite.role, invite: hex(r.invite.id), maker: hex(r.invite.maker) }
      } catch { return {} }
    }
    case 'invite/revoke': {
      try {
        const inv = c.decode(enc.invite, d.invite)
        return { invite: hex(inv.id), role: inv.role, maker: hex(inv.maker) }
      } catch { return {} }
    }
    case 'settings/set': return { policy: d.policy, rules: d.rules }
    case 'writer/add': return { key: hex(d.key) }
    case 'device/remove': return { removed: hex(d.device) }
    case 'subspace/create': return { key: hex(d.key), name: d.name, private: d.private }
    case 'key/rotate': return { epoch: d.epoch }
    default: return {}
  }
}

// `chain`: the sub-space the decision is about and those above it, nearest
// first; [] for the top space.
async function applyOne (d, writer, view, host, space, chain = [], code = null) {
  const scope = chain[0] || null
  const K = (name) => P(scope) + name // this scope's own keys
  if (d.type === 'space/init') {
    if (await view.get('meta')) return
    if (!b4a.equals(writer, space)) return // the space's first writer only
    const info = Identity.verify(d.proof, writerSignable(writer, space))
    if (!info) return
    const owner = hex(info.identity)
    await view.put('meta', { name: d.name, owner, policy: d.policy, private: d.private, version: d.version, parent: d.parent ? hex(d.parent) : null, stamp: d.stamp })
    await view.put(`member:${owner}`, { role: 'owner', by: owner, stamp: d.stamp })
    await view.put(`writer:${hex(writer)}`, { identity: owner, device: hex(info.device), indexer: true })
    await view.put(`writers:${owner}`, { keys: [hex(writer)] })
    return
  }

  const writerNode = await view.get(`writer:${hex(writer)}`)
  if (!writerNode) return
  const author = writerNode.value.identity
  const memberOf = (id) => memberIn(view, chain, id)
  const roleOf = async (id) => {
    const m = await memberOf(id)
    return m ? m.role : null
  }
  // Custom roles (the top space's, for its sub-spaces too), read as needed.
  const custom = new Map()
  const load = async (...names) => {
    for (const name of names) {
      if (!name || ROLES[name] || custom.has(name)) continue
      const node = await view.get(`role:${name}`)
      if (node) custom.set(name, node.value.permissions)
    }
  }
  const authorRole = await roleOf(author)
  await load(authorRole)

  switch (d.type) {
    case 'member/add': {
      if (scope || !can(authorRole, 'decide', custom)) return
      const id = hex(d.identity)
      if (await roleOf(id) || await view.get(`banned:${id}`)) return // already in: never a step down
      await view.put(`member:${id}`, { role: 'member', by: author, stamp: d.stamp })
      await admit(view, K, id, 'member', custom, code)
      return
    }
    case 'member/remove': {
      const id = hex(d.identity)
      const role = await roleOf(id)
      await load(role)
      if (!role || !mayRemove(authorRole, role, 'decide', custom)) return
      if (!(await view.get(K(`member:${id}`)))) return // inside a sub-space: what it gave only
      await view.del(K(`member:${id}`))
      await dropBelow(view, scope, id) // removed here: out of every sub-space below
      const after = await roleOf(id)
      await load(after)
      if (can(role, 'post', custom) && !can(after, 'post', custom)) await recordCut(view, K(`cut:${id}`), d.cut, d.stamp)
      await settle(view, host, id, custom)
      return
    }
    case 'role/define': {
      const name = d.name
      if (scope || !can(authorRole, 'roles', custom) || !name || ROLES[name]) return
      const permissions = [...new Set(d.permissions.filter((p) => typeof p === 'string' && p))]
      const node = await view.get(`role:${name}`)
      // Taking `post` or an app's permission (records aren't ordered against
      // decisions) from a role would need a cut for each holder: refused
      // (give holders another role instead; research.md A5, A9). Hypergraph's
      // own decision rights may go: decisions are checked at their point.
      if (node && node.value.permissions.some((p) => !OWN.includes(p) && !permissions.includes(p))) return
      if (!grantable(authorRole, permissions, custom)) return
      await view.put(`role:${name}`, { permissions, by: author, stamp: d.stamp })
      return
    }
    case 'role/set': {
      const id = hex(d.identity)
      if (await bannedIn(view, chain, id)) return
      const member = await memberOf(id)
      const current = member ? member.role : null
      await load(current, d.role)
      if (!mayAssign(authorRole, current, d.role, custom)) return
      const next = { role: d.role, by: author, stamp: d.stamp, writer: member ? member.writer || null : null, writerDevice: member ? member.writerDevice || null : null }
      await view.put(K(`member:${id}`), next)
      await admit(view, K, id, d.role, custom, code)
      if (current && can(current, 'post', custom) && !can(d.role, 'post', custom)) await recordCut(view, K(`cut:${id}`), d.cut, d.stamp)
      if (current) await recordEditCuts(view, K(`editcut:${id}`), lostAppPermissions(current, d.role, custom), d.cut)
      if (next.writer && mayWrite(d.role, custom)) await addKey(view, host, id, next.writer, next.writerDevice)
      await settle(view, host, id, custom)
      return
    }
    case 'moderate': {
      if (!ACTIONS.includes(d.action) || !can(authorRole, 'moderate', custom)) return
      if (d.action === 'ban') {
        if (d.target.byteLength !== 32) return
        const id = hex(d.target)
        if (await view.get(K(`banned:${id}`))) return
        const role = await roleOf(id)
        await load(role)
        if (!mayRemove(authorRole, role, 'moderate', custom)) return
        await view.put(K(`banned:${id}`), { by: author, reason: d.reason, stamp: d.stamp })
        // Someone with no role here may write in a sub-space below (a guest):
        // the cut the moderator held for their logs there counts.
        if (!role) {
          if (d.cut.length) await recordCut(view, K(`cut:${id}`), d.cut, d.stamp)
          await settle(view, host, id, custom)
          return
        }
        await view.del(K(`member:${id}`))
        if (can(role, 'post', custom)) await recordCut(view, K(`cut:${id}`), d.cut, d.stamp)
        await settle(view, host, id, custom)
        return
      }
      if (d.action === 'unban') {
        // Lifts the ban (this scope's own: a ban above stays); its cut stays,
        // so what they wrote during it never counts: let back in, they write
        // in a new log (research.md A8).
        if (d.target.byteLength !== 32) return
        const id = hex(d.target)
        const ban = await view.get(K(`banned:${id}`))
        if (!ban) return
        const byRole = await roleOf(ban.value.by)
        await load(byRole)
        if (authorRole !== 'owner' && byRole && rankOf(byRole) > rankOf(authorRole)) return // not below who banned
        await view.del(K(`banned:${id}`))
        return
      }
      try { c.decode(enc.recordId, d.target) } catch { return }
      const key = K(`mod:${hex(d.target)}`)
      const node = await view.get(key)
      const m = node ? { ...node.value } : { flagged: false, hidden: false, removed: false }
      if (m.removed) return // for good
      if (d.action === 'flag') m.flagged = true
      else if (d.action === 'hide') m.hidden = true
      else if (d.action === 'reveal') m.hidden = false
      else if (d.action === 'remove') m.removed = true
      await view.put(key, m)
      return
    }
    case 'invite/redeem': {
      if (!can(authorRole, 'decide', custom)) return
      let r = null
      try { r = c.decode(enc.redemption, d.redemption) } catch { return }
      const signer = verifyRedemption(r, space)
      if (!signer) return
      const inv = r.invite
      if (!b4a.equals(inv.space, scope ? b4a.from(scope, 'hex') : space)) return
      const id = hex(r.identity)
      const inviteId = hex(inv.id)
      if (await bannedIn(view, chain, id)) return
      if (await view.get(K(`redeemed:${inviteId}:${id}`))) return // the same person counts once
      if (await view.get(K(`revoked:${inviteId}`))) return
      if (inv.expires && d.stamp > inv.expires) return // the recorder's stamp: a writer's
      const usesNode = await view.get(K(`uses:${inviteId}`))
      const used = usesNode ? usesNode.value.count : 0
      if (inv.uses && used >= inv.uses) return
      const makerRole = await roleOf(hex(inv.maker))
      await load(makerRole, inv.role)
      if (!mayInvite(makerRole, inv.role, custom)) return
      const member = await memberOf(id)
      if (member) await load(member.role)
      if (!member || rankOf(member.role) < rankOf(inv.role)) { // never a step down
        const next = { role: inv.role, by: hex(inv.maker), stamp: d.stamp, writer: hex(r.writer), writerDevice: hex(signer.device) }
        await view.put(K(`member:${id}`), next)
        await admit(view, K, id, inv.role, custom, code)
        if (mayWrite(inv.role, custom)) await addKey(view, host, id, next.writer, next.writerDevice)
        await settle(view, host, id, custom)
      }
      await view.put(K(`redeemed:${inviteId}:${id}`), { at: d.stamp, by: author })
      await view.put(K(`uses:${inviteId}`), { count: used + 1 })
      return
    }
    case 'invite/revoke': {
      // By who may decide, or by the invite's maker.
      let inv = null
      try { inv = c.decode(enc.invite, d.invite) } catch { return }
      if (!b4a.equals(inv.space, scope ? b4a.from(scope, 'hex') : space) || !verifyInvite(inv, space)) return
      if (!can(authorRole, 'decide', custom) && author !== hex(inv.maker)) return
      if (await view.get(K(`revoked:${hex(inv.id)}`))) return
      await view.put(K(`revoked:${hex(inv.id)}`), { by: author, stamp: d.stamp })
      return
    }
    case 'writer/add': {
      // A device's claim: this key writes decisions for my identity. Any
      // writer may record it; it counts for a member who may decide or
      // moderate (in the space or one of its sub-spaces), from a device not
      // removed.
      if (scope) return
      const info = Identity.verify(d.proof, writerSignable(d.key, space))
      if (!info || b4a.equals(info.device, info.identity)) return
      const id = hex(info.identity)
      if (!(await writesAnywhere(view, id, custom))) return
      if (await addKey(view, host, id, hex(d.key), hex(info.device))) await settle(view, host, id, custom)
      return
    }
    case 'settings/set': {
      // The space's storage policy (story 6, FR-027) and the ids of the app
      // rules it runs (core follow-ups): who may decide.
      if (!can(authorRole, 'decide', custom)) return
      const policy = POLICIES.includes(d.policy) ? d.policy : null
      const rules = Array.isArray(d.rules) ? [...new Set(d.rules.filter((r) => typeof r === 'string'))].sort() : null
      // story 9 (T071a): the write limit of an open space; records 0 lifts it
      const limit = d.writeLimit ? (d.writeLimit.records === 0 ? false : validLimit(d.writeLimit) ? { records: d.writeLimit.records, periodMs: d.writeLimit.periodMs } : null) : null
      if (!policy && !rules && limit === null) return
      const meta = await view.get(K('meta'))
      const next = { ...(meta ? meta.value : {}), ...(policy ? { policy } : {}), ...(rules ? { rules } : {}) }
      if (limit) next.writeLimit = limit
      else if (limit === false) delete next.writeLimit
      await view.put(K('meta'), next)
      return
    }
    case 'subspace/create': {
      // A sub-space of this space (story 8), by who may decide here.
      if (!can(authorRole, 'decide', custom)) return
      const key = hex(d.key)
      if (b4a.equals(d.key, space) || await view.get(`subspace:${key}`)) return
      const writeRoles = [...new Set(d.writeRoles.filter((r) => typeof r === 'string' && r))]
      await view.put(`subspace:${key}`, { name: d.name, private: d.private, writeRoles, parent: scope, by: author, stamp: d.stamp })
      const list = await view.get('subspaces')
      await view.put('subspaces', { keys: [...(list ? list.value.keys : []), key] })
      return
    }
    case 'key/rotate': {
      // A private space's next key (spec 008): epoch = the current one + 1,
      // with the commitment grants must open to; by who may decide or
      // moderate there. Of two rotations at once, the first in the order
      // becomes current; the other's key stays readable (`others`): its
      // author may have sealed records with it before the order settled.
      if (!mayWrite(authorRole, custom)) return
      const meta = scope ? (await view.get(`subspace:${scope}`)).value : (await view.get('meta')).value
      if (!meta.private) return
      const node = await view.get(K('epochs'))
      const epochs = node ? node.value : { current: -1, commits: {}, others: {} }
      const commit = hex(d.commit)
      if (d.epoch === epochs.current + 1) {
        await view.put(K('epochs'), { ...epochs, current: d.epoch, commits: { ...epochs.commits, [d.epoch]: commit } })
      } else if (d.epoch >= 0 && d.epoch <= epochs.current && epochs.commits[d.epoch] !== commit && !(epochs.others || {})[commit]) {
        await view.put(K('epochs'), { ...epochs, others: { ...(epochs.others || {}), [commit]: d.epoch } })
      }
      return
    }
    case 'device/remove': {
      // The identity key's signed removal (the same bytes as the record in an
      // identity log): the device's writer keys stop counting, for good.
      if (scope) return
      const info = Identity.verify(d.proof, removalSignable(space, d.device, d.cut))
      if (!info || !b4a.equals(info.device, info.identity)) return
      const id = hex(info.identity)
      const device = hex(d.device)
      if (await view.get(`gone:${id}:${device}`)) return
      await view.put(`gone:${id}:${device}`, { by: author, stamp: d.stamp })
      const dropped = []
      for (const key of await writersOf(view, id)) {
        const node = await view.get(`writer:${key}`)
        if (node && node.value.device === device) dropped.push(key)
      }
      for (const key of dropped) await forget(view, id, key)
      await settle(view, host, id, custom) // another device of theirs settles, if one did
      for (const key of dropped) await removeFromBase(host, key)
    }
  }
}

const mayWrite = (role, custom) => can(role, 'decide', custom) || can(role, 'moderate', custom)

// Removed from `scope` (null: the top space): their own entries in every
// sub-space below it go too (a parent's removal applies below).
async function dropBelow (view, scope, id) {
  const subs = await subspacesOf(view)
  for (const s of subs) {
    if (!below(subs, s.key, scope)) continue
    if (await view.get(`sub:${s.key}:member:${id}`)) await view.del(`sub:${s.key}:member:${id}`)
  }
}

// May this identity's devices write decisions: may it decide or moderate in
// the space, or in one of its sub-spaces?
async function writesAnywhere (view, id, custom) {
  const roles = [await roleIn(view, [], id)]
  for (const s of await subspacesOf(view)) {
    const chain = await chainOf(view, s.key)
    if (chain) roles.push(await roleIn(view, chain, id))
  }
  for (const role of roles) {
    if (!role) continue
    if (!ROLES[role] && !custom.has(role)) {
      const node = await view.get(`role:${role}`)
      if (node) custom.set(role, node.value.permissions)
    }
    if (mayWrite(role, custom)) return true
  }
  return false
}

async function roleIn (view, chain, id) {
  const m = await memberIn(view, chain, id)
  return m ? m.role : null
}

async function writersOf (view, id) {
  const node = await view.get(`writers:${id}`)
  return node ? node.value.keys : []
}

// A device's writer key (hex) for `id`: kept unless known already, or the
// device was removed. Returns whether it was added.
async function addKey (view, host, id, key, device) {
  if (await view.get(`writer:${key}`)) return false
  if (device && await view.get(`gone:${id}:${device}`)) return false
  await view.put(`writer:${key}`, { identity: id, device, indexer: false })
  await view.put(`writers:${id}`, { keys: [...(await writersOf(view, id)), key] })
  if (host) await host.addWriter(b4a.from(key, 'hex'), { indexer: false })
  return true
}

// The key no longer speaks for `id` (Autobase is told separately).
async function forget (view, id, key) {
  await view.del(`writer:${key}`)
  const keys = (await writersOf(view, id)).filter((k) => k !== key)
  if (keys.length) await view.put(`writers:${id}`, { keys })
  else await view.del(`writers:${id}`)
}

// Autobase never removes its last settler: that key stays one for it, but
// nothing it writes counts here any more (it has no `writer:` entry).
async function removeFromBase (host, key) {
  const bytes = b4a.from(key, 'hex')
  if (host && host.removeable(bytes)) await host.removeWriter(bytes)
}

// After any change to a member's roles or keys: unable to decide or moderate
// anywhere (the space or its sub-spaces), their keys go; with `decide` in the
// top space, exactly one of their keys (the first) settles the order;
// otherwise none does.
async function settle (view, host, id, custom) {
  const keys = await writersOf(view, id)
  if (!(await writesAnywhere(view, id, custom))) {
    for (const key of keys) {
      await forget(view, id, key)
      await removeFromBase(host, key)
    }
    return
  }
  const role = await roleIn(view, [], id)
  const nodes = []
  for (const key of keys) nodes.push([key, (await view.get(`writer:${key}`)).value])
  const settler = nodes.find(([, w]) => w.indexer)
  if (can(role, 'decide', custom)) {
    if (settler || !nodes.length) return
    const [key, w] = nodes[0]
    await view.put(`writer:${key}`, { ...w, indexer: true })
    if (host) await host.addWriter(b4a.from(key, 'hex'), { indexer: true })
  } else if (settler) {
    const [key, w] = settler
    await view.put(`writer:${key}`, { ...w, indexer: false })
    if (host && host.removeable(b4a.from(key, 'hex'))) await host.addWriter(b4a.from(key, 'hex'), { indexer: false })
  }
}

// Someone just lost the right to write: their logs count up to the lengths
// the decider held (research.md A4). A log cut earlier keeps its first cut.
// `key`: cut:<id>, or a sub-space's own.
async function recordCut (view, key, entries, stamp) {
  const node = await view.get(key)
  const logs = {}
  for (const { log, length } of entries || []) logs[hex(log)] = length
  if (node) Object.assign(logs, node.value.logs)
  await view.put(key, { logs, stamp })
  const at = key.lastIndexOf('cut:')
  await view.del(key.slice(0, at) + 'admit:' + key.slice(at + 4)) // let back in later: a new code
}

// Someone with a cut is let back in (they may post again): the decision's
// code, which every log they make from now on carries in its header (story 9,
// story 4's gap: a log prepared during a ban, which no cut names, counts for
// nothing, as its maker couldn't know the code). Kept until their next cut.
async function admit (view, K, id, role, custom, code) {
  if (!code || !can(role, 'post', custom) || !(await view.get(K(`cut:${id}`))) || await view.get(K(`admit:${id}`))) return
  await view.put(K(`admit:${id}`), { code })
}

// The app permissions (e.g. 'edit-pages') a role change takes away.
function lostAppPermissions (before, after, custom) {
  const now = permissionsOf(after, custom) || []
  return (permissionsOf(before, custom) || []).filter((p) => p !== 'post' && !OWN.includes(p) && !now.includes(p))
}

// Someone lost app permissions: their records relying on them (edits of a
// shared type, relations and tags on it) count up to the lengths the decider
// held (research.md A9). A log's first cut per permission stays.
async function recordEditCuts (view, key, lost, entries) {
  if (!lost.length) return
  const node = await view.get(key)
  const perms = node ? { ...node.value.perms } : {}
  for (const p of lost) {
    const logs = {}
    for (const { log, length } of entries || []) logs[hex(log)] = length
    perms[p] = { ...logs, ...(perms[p] || {}) }
  }
  await view.put(key, { perms })
}

module.exports = { POLICIES, DECISION_KEY, applyNodes, initProof, writerSignable, removalSignable }
