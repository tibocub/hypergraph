// Identity (keet-identity-key): a person with a recovery phrase; each device
// proves it belongs to the identity; devices sign data on its behalf.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { Identity } = require('../../../lib/identity.js')

test('a new identity comes with a recovery phrase that restores it', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  t.is(a.recoveryPhrase.split(' ').length, 24)
  const b = await Identity.create({ device: crypto.keyPair(), mnemonic: a.recoveryPhrase })
  t.alike(b.publicKey, a.publicKey, 'same identity on another device')
  t.unlike(b.device.publicKey, a.device.publicKey)
})

test('a device proof verifies to its identity and device', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const info = Identity.verifyDevice(a.proof)
  t.alike(info.identity, a.publicKey)
  t.alike(info.device, a.device.publicKey)
})

test('a device attested by another device verifies to the same identity', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const second = crypto.keyPair()
  const proof = a.attestDevice(second.publicKey)
  const b = Identity.fromProof({ device: second, proof })
  t.alike(b.publicKey, a.publicKey)
  t.is(b.recoveryPhrase, null, 'a second device has no phrase')
  const signed = b.attest(b4a.from('hello'))
  const info = Identity.verify(signed, b4a.from('hello'))
  t.alike(info.identity, a.publicKey)
  t.alike(info.device, second.publicKey)
})

test('attested data verifies, and tampered data does not', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const proof = a.attest(b4a.from('log key + space key'))
  t.ok(Identity.verify(proof, b4a.from('log key + space key')))
  t.is(Identity.verify(proof, b4a.from('something else')), null)
  t.is(Identity.verify(b4a.from('garbage'), b4a.from('x')), null, 'garbage never throws')
  const other = await Identity.create({ device: crypto.keyPair() })
  t.is(Identity.fromProof({ device: crypto.keyPair(), proof: other.proof }), null, 'a proof for another device is refused')
})

test('an identity saves and loads (no phrase needed for a second device)', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const saved = a.toJSON()
  const back = Identity.fromProof({ device: a.device, proof: b4a.from(saved.proof, 'hex'), mnemonic: saved.mnemonic })
  t.alike(back.publicKey, a.publicKey)
  t.is(back.recoveryPhrase, a.recoveryPhrase)
})
