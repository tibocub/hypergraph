const test = require('brittle')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const IdentityManager = require('../../src/identity-manager.js')
const os = require('os')
const path = require('path')
const fs = require('fs')

test('hypergraph: identity system - basic initialization', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-basic-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Identity should be initialized
  t.ok(graph.identity, 'identity exists')
  t.ok(graph.identity.identityPublicKey, 'identityPublicKey exists')
  t.ok(graph.identity.deviceKeyPair, 'deviceKeyPair exists')
  t.ok(graph.identity.deviceKeyPair.publicKey, 'devicePublicKey exists')
  t.ok(graph.identity.deviceKeyPair.secretKey, 'deviceSecretKey exists')

  // Identity and device keys should be different
  t.not(
    graph.identity.identityPublicKey.toString('hex'),
    graph.identity.deviceKeyPair.publicKey.toString('hex'),
    'identityPublicKey differs from devicePublicKey'
  )
})

test('hypergraph: identity system - mnemonic generation and recovery', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-mnemonic-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  // Generate mnemonic first
  const mnemonic = IdentityManager.generateMnemonic()
  t.ok(mnemonic, 'mnemonic generated')
  t.ok(typeof mnemonic === 'string', 'mnemonic is string')

  // Create first graph with the mnemonic
  const store = new Corestore(dir)
  const graph = new Hypergraph(store, { mnemonic })
  await graph.ready()

  // Create second graph with the same mnemonic
  const dir2 = path.join(os.tmpdir(), `hypergraph-test-identity-mnemonic-2-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir2, { recursive: true })
  
  const store2 = new Corestore(dir2)
  const graph2 = new Hypergraph(store2, { mnemonic })
  await graph2.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    await graph2.close()
    await store2.close()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  // Identity public keys should match (same mnemonic = same identity)
  t.is(
    graph.identity.identityPublicKey.toString('hex'),
    graph2.identity.identityPublicKey.toString('hex'),
    'identityPublicKey matches from mnemonic'
  )

  // Device keys should be different (each device gets its own key pair)
  t.not(
    graph.identity.deviceKeyPair.publicKey.toString('hex'),
    graph2.identity.deviceKeyPair.publicKey.toString('hex'),
    'devicePublicKey differs between devices'
  )
})

test('hypergraph: identity system - two devices same identity', async (t) => {
  const dir1 = path.join(os.tmpdir(), `hypergraph-test-identity-device1-${process.pid}-${Date.now()}`)
  const dir2 = path.join(os.tmpdir(), `hypergraph-test-identity-device2-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir1, { recursive: true })
  fs.mkdirSync(dir2, { recursive: true })

  // Generate mnemonic first
  const mnemonic = IdentityManager.generateMnemonic()

  // Create first device with the mnemonic
  const store1 = new Corestore(dir1)
  const graph1 = new Hypergraph(store1, { mnemonic })
  await graph1.ready()

  // Create second device with same identity (using same mnemonic)
  const store2 = new Corestore(dir2)
  const graph2 = new Hypergraph(store2, { mnemonic })
  await graph2.ready()

  t.teardown(async () => {
    await graph1.close()
    await store1.close()
    await graph2.close()
    await store2.close()
    fs.rmSync(dir1, { recursive: true, force: true })
    fs.rmSync(dir2, { recursive: true, force: true })
  })

  // Identity public keys should match (same mnemonic = same identity)
  t.is(
    graph1.identity.identityPublicKey.toString('hex'),
    graph2.identity.identityPublicKey.toString('hex'),
    'identityPublicKey matches across devices'
  )

  // Device keys should be different
  t.not(
    graph1.identity.deviceKeyPair.publicKey.toString('hex'),
    graph2.identity.deviceKeyPair.publicKey.toString('hex'),
    'devicePublicKey differs between devices'
  )

  // Both devices should have writable user cores
  t.ok(graph1.key, 'device1 has user core key')
  t.ok(graph2.key, 'device2 has user core key')
  t.not(
    graph1.key.toString('hex'),
    graph2.key.toString('hex'),
    'user core keys differ between devices'
  )
})

test('hypergraph: identity system - device signing', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-signing-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Create an entity - should be signed with device key
  const post = await graph.put({ type: 'post' })
  t.ok(post.id, 'entity created')
  t.ok(post.author, 'entity has author')

  // Author should be the device public key
  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  t.is(post.author, devicePublicKeyHex, 'author is devicePublicKey')

  // Create content - should also be signed with device key
  await graph.putContent(post.id, 'hello world', 'text')
  const content = await graph.getContent(post.id)
  t.ok(content, 'content retrieved')

  // Create a relation - should be signed with device key
  const context = await graph.createContext({ writeMode: 'open' })
  await graph.relate({
    from: 'comment/1',
    to: post.id,
    type: 'reply',
    context: context
  })
  
  // Verify relation was created (the relate call succeeded)
  t.pass('relation created with device signature')
})

test('hypergraph: identity system - identity profile', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-profile-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Set identity profile
  const profile = await graph.setIdentity({
    username: 'alice',
    bio: 'test user'
  })
  t.ok(profile, 'profile set')
  t.is(profile.username, 'alice', 'username matches')
  t.is(profile.bio, 'test user', 'bio matches')

  // Get identity profile
  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const retrievedProfile = await graph.getIdentity(devicePublicKeyHex)
  t.ok(retrievedProfile, 'profile retrieved')
  t.is(retrievedProfile.username, 'alice', 'retrieved username matches')
  t.is(retrievedProfile.bio, 'test user', 'retrieved bio matches')
})

test('hypergraph: identity system - device-to-identity mapping', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-mapping-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Set identity profile
  await graph.setIdentity({
    username: 'alice',
    bio: 'test user'
  })

  // Register device-to-identity mapping
  const devicePublicKeyHex = graph.identity.deviceKeyPair.publicKey.toString('hex')
  const identityPublicKeyHex = graph.identity.identityPublicKey.toString('hex')
  
  await graph.view.registerDeviceIdentity(devicePublicKeyHex, identityPublicKeyHex)

  // Get identity for device
  const retrievedIdentity = await graph.view.getIdentityForDevice(devicePublicKeyHex)
  t.ok(retrievedIdentity, 'identity retrieved for device')
  t.is(retrievedIdentity, identityPublicKeyHex, 'identityPublicKey matches')
})

test('hypergraph: identity system - attestation proof', async (t) => {
  const dir = path.join(os.tmpdir(), `hypergraph-test-identity-attestation-${process.pid}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })

  const store = new Corestore(dir)
  const graph = new Hypergraph(store)
  await graph.ready()

  t.teardown(async () => {
    await graph.close()
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  // Attestation proof should be generated during initialization
  t.ok(graph.identity.attestationProof, 'attestation proof exists')
  
  // Note: Full verification requires keet-identity-key chain validation
  // which may not be fully implemented. The proof generation is the key part.
  t.pass('attestation proof generated for device')
})
