// Applying decisions (research R8), adapted from src/v2/control.js. Runs inside
// Autobase's apply, in the same order on every member, so it must be
// deterministic: it reads only the view and the decision itself, never the
// clock or the network. A decision counts only if its author held the
// permission at that point of the order; anything else, malformed included,
// is skipped.
//
// The view is a Hyperbee (keys: meta, member:<id>, writer:<key>,
// redeemed:<invite>:<id>, uses:<invite>, cut:<id>, role:<name>, banned:<id>,
// mod:<record id>); lib/decisions/state.js reads it.

const c = require('compact-encoding')
const b4a = require('b4a')
const enc = require('../encodings.js')
const { Identity } = require('../identity.js')
const { verifyRedemption } = require('../invites.js')
const { ROLES, RANK, ACTIONS, can, mayAssign, mayRemove, grantable } = require('./state.js')

const hex = (b) => b4a.toString(b, 'hex')
const NS_WRITER = b4a.from('hypergraph/writer\0')

// What a member signs to say "this writer key of the decision log is mine".
const writerSignable = (writerKey, space) => b4a.concat([NS_WRITER, writerKey, space])

function initProof (identity, writerKey, space) {
  return identity.attest(writerSignable(writerKey, space))
}

async function applyNodes (nodes, view, host, { space }) {
  for (const { value, from } of nodes) {
    let d = null
    try { d = c.decode(enc.decision, value) } catch { continue }
    await applyOne(d, from.key, view, host, space)
  }
}

async function applyOne (d, writer, view, host, space) {
  if (d.type === 'space/init') {
    if (await view.get('meta')) return
    if (!b4a.equals(writer, space)) return // the space's first writer only
    const info = Identity.verify(d.proof, writerSignable(writer, space))
    if (!info) return
    const owner = hex(info.identity)
    await view.put('meta', { name: d.name, owner, policy: d.policy, private: d.private, version: d.version, parent: d.parent ? hex(d.parent) : null, stamp: d.stamp })
    await view.put(`member:${owner}`, { role: 'owner', by: owner, stamp: d.stamp })
    await view.put(`writer:${hex(writer)}`, { identity: owner })
    return
  }

  const writerNode = await view.get(`writer:${hex(writer)}`)
  if (!writerNode) return
  const author = writerNode.value.identity
  const memberOf = async (id) => {
    const node = await view.get(`member:${id}`)
    return node ? node.value : null
  }
  const roleOf = async (id) => {
    const m = await memberOf(id)
    return m ? m.role : null
  }
  // Custom roles, read as needed.
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
      if (!can(authorRole, 'decide', custom)) return
      const id = hex(d.identity)
      if (await roleOf(id) || await view.get(`banned:${id}`)) return // already in: never a step down
      await view.put(`member:${id}`, { role: 'member', by: author, stamp: d.stamp })
      return
    }
    case 'member/remove': {
      const id = hex(d.identity)
      const role = await roleOf(id)
      await load(role)
      if (!role || !mayRemove(authorRole, role, 'decide', custom)) return
      await view.del(`member:${id}`)
      if (can(role, 'post', custom)) await recordCut(view, id, d.cut, d.stamp)
      return
    }
    case 'role/define': {
      const name = d.name
      if (!can(authorRole, 'roles', custom) || !name || ROLES[name]) return
      const permissions = [...new Set(d.permissions.filter((p) => typeof p === 'string' && p))]
      const node = await view.get(`role:${name}`)
      // Taking `post` from a role would need a cut for each holder: refused
      // (give holders another role instead; research.md A5).
      if (node && node.value.permissions.includes('post') && !permissions.includes('post')) return
      if (!grantable(authorRole, permissions, custom)) return
      await view.put(`role:${name}`, { permissions, by: author, stamp: d.stamp })
      return
    }
    case 'role/set': {
      const id = hex(d.identity)
      if (await view.get(`banned:${id}`)) return
      const member = await memberOf(id)
      const current = member ? member.role : null
      await load(current, d.role)
      if (!mayAssign(authorRole, current, d.role, custom)) return
      const next = { role: d.role, by: author, stamp: d.stamp, writer: member ? member.writer : null }
      await view.put(`member:${id}`, next)
      if (current && can(current, 'post', custom) && !can(d.role, 'post', custom)) await recordCut(view, id, d.cut, d.stamp)
      await addWriter(view, host, id, next, custom)
      return
    }
    case 'moderate': {
      if (!ACTIONS.includes(d.action) || !can(authorRole, 'moderate', custom)) return
      if (d.action === 'ban') {
        if (d.target.byteLength !== 32) return
        const id = hex(d.target)
        if (await view.get(`banned:${id}`)) return
        const role = await roleOf(id)
        await load(role)
        if (!mayRemove(authorRole, role, 'moderate', custom)) return
        await view.put(`banned:${id}`, { by: author, reason: d.reason, stamp: d.stamp })
        if (!role) return
        await view.del(`member:${id}`)
        if (can(role, 'post', custom)) await recordCut(view, id, d.cut, d.stamp)
        return
      }
      try { c.decode(enc.recordId, d.target) } catch { return }
      const key = `mod:${hex(d.target)}`
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
      if (!verifyRedemption(r)) return
      const inv = r.invite
      if (!b4a.equals(inv.space, space)) return
      const id = hex(r.identity)
      const inviteId = hex(inv.id)
      if (await view.get(`banned:${id}`)) return
      if (await view.get(`redeemed:${inviteId}:${id}`)) return // the same person counts once
      if (inv.expires && d.stamp > inv.expires) return
      const usesNode = await view.get(`uses:${inviteId}`)
      const used = usesNode ? usesNode.value.count : 0
      if (inv.uses && used >= inv.uses) return
      const makerRole = await roleOf(hex(inv.maker))
      if (!can(makerRole, 'invite', custom) || !ROLES[inv.role] || inv.role === 'owner') return
      if (makerRole !== 'owner' && RANK[inv.role] >= RANK[makerRole]) return
      const member = await memberOf(id)
      if (!member || (RANK[member.role] || 0) < RANK[inv.role]) {
        const next = { role: inv.role, by: hex(inv.maker), stamp: d.stamp, writer: hex(r.writer) }
        await view.put(`member:${id}`, next)
        await addWriter(view, host, id, next, custom)
      }
      await view.put(`redeemed:${inviteId}:${id}`, { at: d.stamp, by: author })
      await view.put(`uses:${inviteId}`, { count: used + 1 })
    }
  }
}

// A member whose role lets them decide or moderate: their device's writer
// key (from their redemption) becomes a writer of the decision log. Demoted
// later, it stays a writer, but its decisions no longer count (applyOne
// checks the author's role at each point).
async function addWriter (view, host, id, member, custom) {
  if (!member.writer || !(can(member.role, 'decide', custom) || can(member.role, 'moderate', custom))) return
  if (await view.get(`writer:${member.writer}`)) return
  await view.put(`writer:${member.writer}`, { identity: id })
  if (host) await host.addWriter(b4a.from(member.writer, 'hex'), { indexer: false })
}

// Someone just lost the right to write: their logs count up to the lengths
// the decider held (research.md A4). A log cut earlier keeps its first cut.
async function recordCut (view, id, entries, stamp) {
  const node = await view.get(`cut:${id}`)
  const logs = {}
  for (const { log, length } of entries || []) logs[hex(log)] = length
  if (node) Object.assign(logs, node.value.logs)
  await view.put(`cut:${id}`, { logs, stamp })
}

module.exports = { applyNodes, initProof, writerSignable }
