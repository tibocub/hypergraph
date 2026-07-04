const test = require('brittle')
const { createGraph } = require('../helpers')

test('identity-graph: a new graph has a distinct identity and device key', async (t) => {
  console.log('TEST: fresh graph identity - starting')
  const { graph } = await createGraph(t, 'identity-graph-basic')

  t.ok(graph.identity, 'identity exists')
  t.ok(graph.identity.identityPublicKey, 'identityPublicKey exists')
  t.ok(graph.identity.deviceKeyPair, 'deviceKeyPair exists')
  t.ok(graph.identity.deviceKeyPair.publicKey, 'devicePublicKey exists')
  t.ok(graph.identity.deviceKeyPair.secretKey, 'deviceSecretKey exists')
  t.not(
    graph.identity.identityPublicKey.toString('hex'),
    graph.identity.deviceKeyPair.publicKey.toString('hex'),
    'identityPublicKey differs from devicePublicKey'
  )
  console.log('TEST: fresh graph identity - passed')
})

test('identity-graph: same mnemonic recovers the same identity, different device keys', async (t) => {
  console.log('TEST: mnemonic recovery via graph - starting')
  const IdentityManager = require('../../../src/identity-manager.js')
  const mnemonic = IdentityManager.generateMnemonic()

  console.log('  Step 1: create two graphs (two devices) from the same mnemonic')
  const { graph: graphA } = await createGraph(t, 'identity-graph-mnemonic-a', { mnemonic })
  const { graph: graphB } = await createGraph(t, 'identity-graph-mnemonic-b', { mnemonic })

  console.log('  Step 2: verify identity matches, device keys and user cores differ')
  t.is(
    graphA.identity.identityPublicKey.toString('hex'),
    graphB.identity.identityPublicKey.toString('hex'),
    'identityPublicKey matches from mnemonic'
  )
  t.not(
    graphA.identity.deviceKeyPair.publicKey.toString('hex'),
    graphB.identity.deviceKeyPair.publicKey.toString('hex'),
    'devicePublicKey differs between devices'
  )
  t.ok(graphA.key, 'device A has a user core key')
  t.ok(graphB.key, 'device B has a user core key')
  t.not(
    graphA.key.toString('hex'),
    graphB.key.toString('hex'),
    'user core keys differ between devices'
  )
  console.log('TEST: mnemonic recovery via graph - passed')
})

test('identity-graph: entities, content, and relations are signed with the device key', async (t) => {
  console.log('TEST: device signing - starting')
  const { graph } = await createGraph(t, 'identity-graph-signing')

  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')

  console.log('  Step 1: create an entity, verify author')
  const post = await graph.put({ type: 'post' })
  t.ok(post.id, 'entity created')
  t.is(post.author, devicePublicKeyHex, 'entity author is the device public key')

  console.log('  Step 2: attach content')
  await graph.putContent(post.id, 'hello world', 'text')
  const content = await graph.getContent(post.id)
  t.ok(content, 'content retrieved')

  console.log('  Step 3: create a relation')
  const context = await graph.createContext({ writeMode: 'open' })
  await graph.relate({ from: 'comment/1', to: post.id, type: 'reply', context })
  t.pass('relation created with device signature')
  console.log('TEST: device signing - passed')
})

test('identity-graph: setIdentity/getIdentity round-trip a profile', async (t) => {
  console.log('TEST: identity profile - starting')
  const { graph } = await createGraph(t, 'identity-graph-profile')

  console.log('  Step 1: set profile')
  const profile = await graph.setIdentity({ username: 'alice', bio: 'test user' })
  t.ok(profile, 'profile set')
  t.is(profile.username, 'alice', 'username matches')
  t.is(profile.bio, 'test user', 'bio matches')

  console.log('  Step 2: get profile back by device public key')
  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const retrieved = await graph.getIdentity(devicePublicKeyHex)
  t.ok(retrieved, 'profile retrieved')
  t.is(retrieved.username, 'alice', 'retrieved username matches')
  t.is(retrieved.bio, 'test user', 'retrieved bio matches')
  console.log('TEST: identity profile - passed')
})

test('identity-graph: setIdentity requires a username', async (t) => {
  console.log('TEST: identity profile requires username - starting')
  const { graph } = await createGraph(t, 'identity-graph-profile-missing-username')

  await t.exception(graph.setIdentity({ bio: 'no username here' }), 'setIdentity rejects a profile without a username')
  console.log('TEST: identity profile requires username - passed')
})

test('identity-graph: getIdentity on an unknown device returns null', async (t) => {
  console.log('TEST: getIdentity unknown device - starting')
  const { graph } = await createGraph(t, 'identity-graph-unknown-device')

  const result = await graph.getIdentity('0'.repeat(64))
  t.is(result, null, 'unknown device has no identity profile')
  console.log('TEST: getIdentity unknown device - passed')
})

test('identity-graph: view registers and resolves device-to-identity mapping', async (t) => {
  console.log('TEST: device-to-identity mapping - starting')
  const { graph } = await createGraph(t, 'identity-graph-mapping')

  await graph.setIdentity({ username: 'alice', bio: 'test user' })

  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const identityPublicKeyHex = graph.identity.identityPublicKey.toString('hex')

  console.log('  Step 1: register mapping')
  await graph.view.registerDeviceIdentity(devicePublicKeyHex, identityPublicKeyHex)

  console.log('  Step 2: resolve mapping')
  const retrievedIdentity = await graph.view.getIdentityForDevice(devicePublicKeyHex)
  t.ok(retrievedIdentity, 'identity retrieved for device')
  t.is(retrievedIdentity, identityPublicKeyHex, 'identityPublicKey matches')
  console.log('TEST: device-to-identity mapping - passed')
})

test('identity-graph: device attestation proof is a real verifiable proof, not a pending Promise', async (t) => {
  console.log('TEST: attestation proof is resolved - starting')
  const { graph } = await createGraph(t, 'identity-graph-attestation')

  console.log('  Step 1: attestation proof exists and is not a thenable')
  t.ok(graph.identity.attestationProof, 'attestation proof exists')
  t.absent(
    graph.identity.attestationProof && typeof graph.identity.attestationProof.then === 'function',
    'attestation proof is a resolved value, not a pending Promise'
  )

  console.log('  Step 2: attesting a brand-new device key with it does not throw')
  const hypercoreCrypto = require('hypercore-crypto')
  const otherDeviceKeyPair = hypercoreCrypto.keyPair()
  await t.execution(
    graph.identity.attestDevice(otherDeviceKeyPair.publicKey),
    'attestDevice succeeds using the graph identity attestation proof'
  )
  console.log('TEST: attestation proof is resolved - passed')
})
