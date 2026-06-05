// Build initial registry state
function initRegistry (ownerPubkeyHex) {
  if (typeof ownerPubkeyHex !== 'string' || ownerPubkeyHex.length === 0) {
    throw new Error('ownerPubkeyHex is required')
  }

  return {
    version: 1,
    roles: {
      owner: ['*'],
      admin: ['mod.add', 'mod.remove', 'content.remove', 'content.hide', 'content.reveal', 'context.write'],
      mod: ['content.hide', 'content.remove', 'content.flag'],
      member: []
    },
    members: {
      [ownerPubkeyHex]: 'owner'
    }
  }
}

function applyRoleEvent (registry, event) {
  if (!event || typeof event.type !== 'string') throw new Error('event.type is required')

  const next = registry
    ? {
        version: registry.version,
        roles: { ...(registry.roles || {}) },
        members: { ...(registry.members || {}) }
      }
    : { version: 1, roles: {}, members: {} }

  if (next.version !== 1) throw new Error('Unsupported registry version')

  switch (event.type) {
    case 'roles/init': {
      const membersEmpty = !next.members || Object.keys(next.members).length === 0
      if (!membersEmpty) return next
      if (!event.registry || typeof event.registry !== 'object') throw new Error('event.registry is required')

      const r = event.registry
      if (r.version !== 1) throw new Error('Unsupported registry version')

      return {
        version: 1,
        roles: { ...(r.roles || {}) },
        members: { ...(r.members || {}) }
      }
    }

    case 'roles/setRole': {
      if (typeof event.member !== 'string' || event.member.length === 0) throw new Error('event.member is required')
      if (typeof event.role !== 'string' || event.role.length === 0) throw new Error('event.role is required')
      next.members[event.member] = event.role
      return next
    }

    case 'roles/removeMember': {
      if (typeof event.member !== 'string' || event.member.length === 0) throw new Error('event.member is required')
      delete next.members[event.member]
      return next
    }

    case 'roles/setRolePermissions': {
      if (typeof event.role !== 'string' || event.role.length === 0) throw new Error('event.role is required')
      if (!Array.isArray(event.permissions)) throw new Error('event.permissions must be an array')
      next.roles[event.role] = event.permissions.slice()
      return next
    }

    default:
      return next
  }
}

function can (registry, pubkeyHex, action) {
  if (!registry || typeof registry !== 'object') return false
  if (!registry.members || !registry.roles) return false
  if (typeof pubkeyHex !== 'string' || pubkeyHex.length === 0) return false
  if (typeof action !== 'string' || action.length === 0) return false

  const roleName = registry.members[pubkeyHex] || (registry.roles.member ? 'member' : null)
  if (!roleName) return false

  const perms = registry.roles[roleName]
  if (!Array.isArray(perms)) return false

  return perms.includes('*') || perms.includes(action)
}

module.exports = {
  initRegistry,
  applyRoleEvent,
  can
}
