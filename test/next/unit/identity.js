// Identity (keet-identity-key): a person with a recovery phrase; each device
// proves it belongs to the identity; devices sign data on its behalf.

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const c = require('compact-encoding')
const IdentityKey = require('keet-identity-key')
const { Identity } = require('../../../lib/identity.js')
const { readHeader } = require('../../../lib/log.js')
const enc = require('../../../lib/encodings.js')

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

// Every device proves itself straight from the identity key (research.md A7,
// A8): a device attesting another one would let a stolen device mint devices
// that no removal names, so such a chain never verifies.
test('a device attested by another device does not verify', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const minted = crypto.keyPair()
  const proof = IdentityKey.attestDevice(minted.publicKey, a.device, a.proof)
  t.is(Identity.verifyDevice(proof), null, 'not as a device proof')
  t.is(Identity.fromProof({ device: minted, proof }), null)
  const signed = IdentityKey.attestData(b4a.from('hello'), minted, proof)
  t.is(Identity.verify(signed, b4a.from('hello')), null, 'nor what the minted device signs')

  const space = crypto.randomBytes(32)
  const core = crypto.keyPair()
  const header = c.encode(enc.header, { version: enc.VERSION, space, decisions: space, proof: IdentityKey.attestData(b4a.concat([b4a.from('hypergraph/log\0'), core.publicKey, space]), minted, proof) })
  t.is(readHeader(header, core.publicKey, space), null, 'nor a log it heads')
})

test('the identity key itself, and a device bootstrapped from it, verify', async (t) => {
  const a = await Identity.create({ device: crypto.keyPair() })
  const { keyPair } = await Identity.secrets(a.recoveryPhrase)
  const info = Identity.verify(Identity.attestAsIdentity(b4a.from('x'), keyPair), b4a.from('x'))
  t.alike(info.identity, a.publicKey)
  t.alike(info.device, a.publicKey, 'signed by the identity key: its "device" is the identity')
  t.alike(Identity.verify(a.attest(b4a.from('x')), b4a.from('x')).device, a.device.publicKey)
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
