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

  identity.clear()
  t.is(identity.deviceKeyPair, null, 'device key pair is cleared')
  t.is(identity.attestationProof, null, 'attestation proof is cleared')
  console.log('TEST: clear - passed')
})
