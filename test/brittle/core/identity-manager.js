const test = require('brittle')
const IdentityManager = require('../../../src/identity-manager.js')

test('identity-manager: generates a fresh identity when created with no opts', async (t) => {
  console.log('TEST: fresh identity - starting')
  const identity = new IdentityManager()
  await identity.init()

  t.ok(identity.identityPublicKey, 'identityPublicKey is set')
  t.ok(identity.deviceKeyPair, 'deviceKeyPair is set')
  t.ok(identity.deviceKeyPair.publicKey, 'device publicKey is set')
  t.ok(identity.deviceKeyPair.secretKey, 'device secretKey is set')
  t.not(
    identity.identityPublicKey.toString('hex'),
    identity.deviceKeyPair.publicKey.toString('hex'),
    'identity key differs from device key'
  )
  console.log('TEST: fresh identity - passed')
})

test('identity-manager: generateMnemonic returns a usable recovery phrase', async (t) => {
  console.log('TEST: generateMnemonic - starting')
  const mnemonic = IdentityManager.generateMnemonic()
  t.ok(mnemonic, 'mnemonic generated')
  t.ok(typeof mnemonic === 'string', 'mnemonic is a string')
  t.ok(mnemonic.split(' ').length >= 12, 'mnemonic has at least 12 words')
  console.log('TEST: generateMnemonic - passed')
})

test('identity-manager: same mnemonic recovers the same identity across instances', async (t) => {
  console.log('TEST: mnemonic recovery - starting')
  const mnemonic = IdentityManager.generateMnemonic()

  console.log('  Step 1: create two independent managers from the same mnemonic')
  const identityA = IdentityManager.fromMnemonic(mnemonic)
  await identityA.init()
  const identityB = IdentityManager.fromMnemonic(mnemonic)
  await identityB.init()

  console.log('  Step 2: verify identity keys match, device keys differ')
  t.is(
    identityA.identityPublicKey.toString('hex'),
    identityB.identityPublicKey.toString('hex'),
    'identityPublicKey matches when recovered from the same mnemonic'
  )
  t.not(
    identityA.deviceKeyPair.publicKey.toString('hex'),
    identityB.deviceKeyPair.publicKey.toString('hex'),
    'each instance still gets its own device key pair'
  )
  console.log('TEST: mnemonic recovery - passed')
})

test('identity-manager: encryptionKeyPair is stable across devices sharing an identity, unlike deviceKeyPair', async (t) => {
  console.log('TEST: encryptionKeyPair cross-device stability - starting')
  const mnemonic = IdentityManager.generateMnemonic()

  const identityA = IdentityManager.fromMnemonic(mnemonic)
  await identityA.init()
  const identityB = IdentityManager.fromMnemonic(mnemonic)
  await identityB.init()

  t.is(
    identityA.encryptionKeyPair.publicKey.toString('hex'),
    identityB.encryptionKeyPair.publicKey.toString('hex'),
    'encryptionKeyPair matches across two instances of the same identity (unlike deviceKeyPair, which is per-device)'
  )
  t.is(
    identityA.encryptionKeyPair.secretKey.toString('hex'),
    identityB.encryptionKeyPair.secretKey.toString('hex'),
    'secretKey also matches — either device can independently derive it and open something sealed to the other'
  )
  t.is(identityA.encryptionKeyPair.publicKey.length, 32, 'publicKey is 32 bytes (crypto_box/X25519)')
  t.is(identityA.encryptionKeyPair.secretKey.length, 32, 'secretKey is 32 bytes (crypto_box/X25519)')

  console.log('  Step: restoring the same identity later (e.g. app restart) gives the same encryptionKeyPair again')
  const identityA2 = IdentityManager.fromMnemonic(mnemonic)
  await identityA2.init()
  t.is(
    identityA2.encryptionKeyPair.publicKey.toString('hex'),
    identityA.encryptionKeyPair.publicKey.toString('hex'),
    'deterministic: the same mnemonic always derives the same encryptionKeyPair'
  )
  console.log('TEST: encryptionKeyPair cross-device stability - passed')
})

test('identity-manager: encryptionKeyPair differs between different identities', async (t) => {
  console.log('TEST: encryptionKeyPair cross-identity distinctness - starting')
  const identityA = new IdentityManager()
  await identityA.init()
  const identityB = new IdentityManager()
  await identityB.init()

  t.not(
    identityA.encryptionKeyPair.publicKey.toString('hex'),
    identityB.encryptionKeyPair.publicKey.toString('hex'),
    'two different identities get different encryptionKeyPairs'
  )
  console.log('TEST: encryptionKeyPair cross-identity distinctness - passed')
})

test('identity-manager: encryptionKeyPair works with hypercore-crypto\'s encrypt()/decrypt() (crypto_box_seal) — the actual intended use case', async (t) => {
  console.log('TEST: encryptionKeyPair seal round-trip - starting')
  const hypercoreCrypto = require('hypercore-crypto')
  const mnemonic = IdentityManager.generateMnemonic()

  // Two devices of the same identity — simulating a real multi-device
  // scenario: one device seals a secret to the identity's public
  // encryption key, a DIFFERENT device (same identity) opens it.
  const deviceA = IdentityManager.fromMnemonic(mnemonic)
  await deviceA.init()
  const deviceB = IdentityManager.fromMnemonic(mnemonic)
  await deviceB.init()

  const secret = Buffer.from('a scope key, or any other secret meant only for this identity')
  const sealed = hypercoreCrypto.encrypt(secret, deviceA.encryptionKeyPair.publicKey)

  const openedByB = hypercoreCrypto.decrypt(sealed, deviceB.encryptionKeyPair)
  t.ok(openedByB, 'a different device of the same identity can open it')
  t.is(openedByB.toString(), secret.toString(), 'the opened plaintext matches the original secret')

  console.log('  Step: a different identity entirely cannot open it')
  const stranger = new IdentityManager()
  await stranger.init()
  const openedByStranger = hypercoreCrypto.decrypt(sealed, stranger.encryptionKeyPair)
  t.is(openedByStranger, null, 'a different identity cannot open a secret sealed to someone else')
  console.log('TEST: encryptionKeyPair seal round-trip - passed')
})

test('identity-manager: init() bootstraps an attestation proof for the device', async (t) => {
  console.log('TEST: attestation on init - starting')
  const identity = new IdentityManager()
  t.is(identity.attestationProof, null, 'no attestation proof before init')

  await identity.init()
  t.ok(identity.attestationProof, 'attestation proof exists after init')
  console.log('TEST: attestation on init - passed')
})

test('identity-manager: attestDevice produces a proof verifiable via verifyProof', async (t) => {
  console.log('TEST: attestDevice/verifyProof - starting')
  const identity = new IdentityManager()
  await identity.init()

  console.log('  Step 1: attest a second device key')
  const hypercoreCrypto = require('hypercore-crypto')
  const newDeviceKeyPair = hypercoreCrypto.keyPair()
  const proof = identity.attestDevice(newDeviceKeyPair.publicKey)
  t.ok(proof, 'attestDevice returns a proof')

  console.log('  Step 2: verify the proof')
  const info = identity.verifyProof(proof)
  t.ok(info, 'verifyProof returns verification info for a valid proof')
  console.log('TEST: attestDevice/verifyProof - passed')
})

test('identity-manager: clear() wipes private device/identity state', async (t) => {
  console.log('TEST: clear - starting')
  const identity = new IdentityManager()
  await identity.init()
  t.ok(identity.deviceKeyPair, 'device key pair set before clear')

  const encKeyPairBeforeClear = identity.encryptionKeyPair
  t.ok(encKeyPairBeforeClear.secretKey.some(b => b !== 0), 'encryption secret key has actual key material before clear')

  identity.clear()
  t.is(identity.deviceKeyPair, null, 'device key pair is cleared')
  t.is(identity.attestationProof, null, 'attestation proof is cleared')
  t.ok(encKeyPairBeforeClear.secretKey.every(b => b === 0), 'the encryption secret key material is zeroed, not just dereferenced')
  console.log('TEST: clear - passed')
})
