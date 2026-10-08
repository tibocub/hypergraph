// Applying decisions (research R8), adapted from src/v2/control.js. Runs inside
// Autobase's apply, in the same order on every member, so it must be
// deterministic: it reads only the view and the decision itself, never the
// clock or the network. A decision counts only if its author held the
// permission at that point of the order; anything else, malformed included,
// is skipped.
//
// The view is a Hyperbee (keys: meta, member:<id>, writer:<key>,
// redeemed:<invite>:<id>, uses:<invite>); lib/decisions/state.js reads it.

const c = require('compact-encoding')
const b4a = require('b4a')
const enc = require('../encodings.js')
const { Identity } = require('../identity.js')
const { verifyRedemption } = require('../invites.js')
const { ROLES, RANK, can } = require('./state.js')

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
  const roleOf = async (id) => {
    const node = await view.get(`member:${id}`)
    return node ? node.value.role : null
  }
  const authorRole = await roleOf(author)

  switch (d.type) {
    case 'member/add': {
      if (!can(authorRole, 'decide')) return
      const id = hex(d.identity)
      if (await roleOf(id)) return // already in: never a step down
      await view.put(`member:${id}`, { role: 'member', by: author, stamp: d.stamp })
      return
    }
    case 'member/remove': {
      if (!can(authorRole, 'decide')) return
      const id = hex(d.identity)
      const role = await roleOf(id)
      if (!role || role === 'owner' || (authorRole !== 'owner' && RANK[role] >= RANK[authorRole])) return
      await view.del(`member:${id}`)
      return
    }
    case 'invite/redeem': {
      if (!can(authorRole, 'decide')) return
      let r = null
      try { r = c.decode(enc.redemption, d.redemption) } catch { return }
      if (!verifyRedemption(r)) return
      const inv = r.invite
      if (!b4a.equals(inv.space, space)) return
      const id = hex(r.identity)
      const inviteId = hex(inv.id)
      if (await view.get(`redeemed:${inviteId}:${id}`)) return // the same person counts once
      if (inv.expires && d.stamp > inv.expires) return
      const usesNode = await view.get(`uses:${inviteId}`)
      const used = usesNode ? usesNode.value.count : 0
      if (inv.uses && used >= inv.uses) return
      const makerRole = await roleOf(hex(inv.maker))
      if (!can(makerRole, 'invite') || !ROLES[inv.role] || inv.role === 'owner') return
      if (makerRole !== 'owner' && RANK[inv.role] >= RANK[makerRole]) return
      const current = await roleOf(id)
      if (!current || RANK[current] < RANK[inv.role]) await view.put(`member:${id}`, { role: inv.role, by: hex(inv.maker), stamp: d.stamp })
      await view.put(`redeemed:${inviteId}:${id}`, { at: d.stamp, by: author })
      await view.put(`uses:${inviteId}`, { count: used + 1 })
    }
  }
}

module.exports = { applyNodes, initProof, writerSignable }
