const test = require('brittle')
const crypto = require('hypercore-crypto')
const { createGraph } = require('../helpers')

test('roles: createRoleBase attaches a usable RoleBase to the graph', async (t) => {
  console.log('TEST: createRoleBase - starting')
  const { graph } = await createGraph(t, 'roles-create')

  const ownerKeyPair = crypto.keyPair()
  const owner = ownerKeyPair.publicKey.toString('hex')

  console.log('  Step 1: create and init the role base')
  const roleKeyHex = await graph.createRoleBase()
  t.ok(roleKeyHex, 'createRoleBase returns a key')
  await graph.roleBase.init(owner)
  await graph.update()

  console.log('  Step 2: verify the owner has full privileges')
  t.is(await graph.getRole(owner), 'owner', 'owner has the owner role')
  t.ok(await graph.can(owner, '*'), 'owner can do anything')
  console.log('TEST: createRoleBase - passed')
})

test('roles: getRole/can throw when no RoleBase is open', async (t) => {
  console.log('TEST: no RoleBase open - starting')
  const { graph } = await createGraph(t, 'roles-not-open')

  await t.exception(graph.getRole('a'.repeat(64)), /RoleBase is not open/, 'getRole requires an open RoleBase')
  await t.exception(graph.can('a'.repeat(64), '*'), /RoleBase is not open/, 'can requires an open RoleBase')
  console.log('TEST: no RoleBase open - passed')
})

test('roles: can() correctly evaluates wildcard, specific, and unknown members', async (t) => {
  console.log('TEST: can() correctness - starting')
  const { graph } = await createGraph(t, 'roles-can')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')

  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.update()

  t.ok(await graph.can(ownerPubkey, '*'), 'owner has wildcard privilege')
  t.ok(await graph.can(ownerPubkey, 'content.remove'), 'owner can perform content.remove')
  t.ok(await graph.can(ownerPubkey, 'mod.add'), 'owner can perform mod.add')
  t.absent(await graph.can('deadbeef'.repeat(8), 'content.flag'), 'unknown member has no permissions')
  console.log('TEST: can() correctness - passed')
})

test('roles: setRole assigns a role that getRole/can reflect after update', async (t) => {
  console.log('TEST: setRole - starting')
  const { graph } = await createGraph(t, 'roles-set-role')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')

  console.log('  Step 1: init role base with owner, grant member permissions')
  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.roleBase.append({
    type: 'roles/setRolePermissions',
    role: 'member',
    permissions: ['content.flag'],
    author: ownerPubkey,
    timestamp: Date.now()
  })
  await graph.update()

  console.log('  Step 2: setRole for the member and verify')
  await graph.setRole(memberPubkey, 'member', { keyPair: ownerKeyPair })
  await graph.update()

  t.is(await graph.getRole(memberPubkey), 'member', 'member has the assigned role')
  t.ok(await graph.can(memberPubkey, 'content.flag'), 'member can perform granted permission')
  t.absent(await graph.can(memberPubkey, 'content.remove'), 'member cannot perform ungranted permission')
  console.log('TEST: setRole - passed')
})

test('roles: setRole requires a signing keyPair', async (t) => {
  console.log('TEST: setRole requires keyPair - starting')
  const { graph } = await createGraph(t, 'roles-set-role-no-keypair')

  const ownerKeyPair = crypto.keyPair()
  await graph.createRoleBase()
  await graph.roleBase.init(ownerKeyPair.publicKey.toString('hex'))
  await graph.update()

  await t.exception(
    graph.setRole('a'.repeat(64), 'member', {}),
    /opts.keyPair is required/,
    'setRole rejects missing keyPair'
  )
  console.log('TEST: setRole requires keyPair - passed')
})

test('roles: removeRole revokes a previously assigned role', async (t) => {
  console.log('TEST: removeRole - starting')
  const { graph } = await createGraph(t, 'roles-remove-role')

  const ownerKeyPair = crypto.keyPair()
  const ownerPubkey = ownerKeyPair.publicKey.toString('hex')
  const memberKeyPair = crypto.keyPair()
  const memberPubkey = memberKeyPair.publicKey.toString('hex')

  await graph.createRoleBase()
  await graph.roleBase.init(ownerPubkey)
  await graph.update()

  console.log('  Step 1: assign then confirm role')
  await graph.setRole(memberPubkey, 'member', { keyPair: ownerKeyPair })
  await graph.update()
  t.is(await graph.getRole(memberPubkey), 'member', 'member role assigned')

  console.log('  Step 2: remove and confirm role is gone')
  await graph.removeRole(memberPubkey, { author: ownerPubkey })
  await graph.update()
  t.is(await graph.getRole(memberPubkey), null, 'member role removed')
  console.log('TEST: removeRole - passed')
})
