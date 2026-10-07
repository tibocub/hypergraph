// v2 private channels: encryption primitives (spec 008, research R2, R3).

const test = require('brittle')
const b4a = require('b4a')
const hcrypto = require('hypercore-crypto')
const { boxKeyPair, seal, openSealed, newEpochKey, commitOf, messageAD, encryptMessage, decryptMessage } = require('../../../src/v2/crypto')

const identity = () => ({ keyPair: hcrypto.keyPair(), seed: hcrypto.randomBytes(32) })

test('v2 crypto: an identity has one encryption key pair, the same on every device', (t) => {
  const a = identity()
  const again = { keyPair: a.keyPair, seed: b4a.from(a.seed) } // another device: same seed
  t.alike(boxKeyPair(a).publicKey, boxKeyPair(again).publicKey, 'same seed, same key pair')
  t.unlike(boxKeyPair(a).publicKey, boxKeyPair(identity()).publicKey, 'another identity, another key pair')
  const noSeed = { keyPair: a.keyPair }
  t.alike(boxKeyPair(noSeed).publicKey, boxKeyPair({ keyPair: a.keyPair }).publicKey, 'without a seed: from the secret key, stable')
})

test('v2 crypto: a sealed epoch key opens only for its recipient', (t) => {
  const alice = boxKeyPair(identity())
  const bob = boxKeyPair(identity())
  const key = newEpochKey()
  const sealed = seal(key, alice.publicKey)
  t.alike(openSealed(sealed, alice), key, 'the recipient opens it')
  t.is(openSealed(sealed, bob), null, 'anyone else gets nothing')
  t.is(openSealed(b4a.alloc(sealed.length), alice), null, 'garbage gets nothing')
  t.is(commitOf(key).length, 32)
  t.unlike(commitOf(key), commitOf(newEpochKey()))
})

test('v2 crypto: a message box opens only with its key and its exact context', (t) => {
  const community = hcrypto.randomBytes(32)
  const log = hcrypto.randomBytes(32)
  const key = newEpochKey()
  const ad = messageAD(community, 'chan', log, 3, 1791000000000)
  const { nonce, box } = encryptMessage(key, ad, b4a.from('secret text'))
  t.is(b4a.indexOf(box, b4a.from('secret')), -1, 'no plain text in the box')
  t.alike(decryptMessage(key, ad, nonce, box), b4a.from('secret text'), 'opens with the same key and context')
  t.is(decryptMessage(newEpochKey(), ad, nonce, box), null, 'another key: nothing')
  for (const [what, other] of [
    ['community', messageAD(hcrypto.randomBytes(32), 'chan', log, 3, 1791000000000)],
    ['channel', messageAD(community, 'other', log, 3, 1791000000000)],
    ['log', messageAD(community, 'chan', hcrypto.randomBytes(32), 3, 1791000000000)],
    ['epoch', messageAD(community, 'chan', log, 4, 1791000000000)],
    ['time', messageAD(community, 'chan', log, 3, 1791000000001)]
  ]) t.is(decryptMessage(key, other, nonce, box), null, `another ${what}: nothing`)
  const tampered = b4a.from(box)
  tampered[0] ^= 1
  t.is(decryptMessage(key, ad, nonce, tampered), null, 'tampered: nothing')
})
