// Private spaces' cryptography (story 8, research.md A13; spec 008's design):
// epoch keys sealed to a device's box key (its device key pair converted),
// grants that count only with the epoch's commitment, records sealed with
// the space, log, position and epoch as additional data.

const test = require('brittle')
const b4a = require('b4a')
const hc = require('hypercore-crypto')
const crypto = require('../../../lib/private/crypto.js')
const grants = require('../../../lib/private/grants.js')

test('an epoch key sealed to a device opens on that device only', (t) => {
  const phone = hc.keyPair()
  const other = hc.keyPair()
  const key = crypto.newEpochKey()
  const commits = { current: 0, commits: { 0: b4a.toString(crypto.commitOf(key), 'hex') }, others: {} }
  const g = grants.makeGrant(key, 0, crypto.commitOf(key), phone.publicKey)
  const opened = grants.openGrant(g, crypto.boxKeyPair(phone), commits)
  t.ok(opened && b4a.equals(opened.key, key), 'the device opens its grant')
  t.is(grants.openGrant(g, crypto.boxKeyPair(other), commits), null, 'another device can\'t')
  t.ok(grants.current(g, commits))
})

test('a grant counts only with its epoch\'s commitment', (t) => {
  const phone = hc.keyPair()
  const real = crypto.newEpochKey()
  const fake = crypto.newEpochKey()
  const commits = { current: 1, commits: { 1: b4a.toString(crypto.commitOf(real), 'hex') }, others: {} }
  const g = grants.makeGrant(fake, 1, crypto.commitOf(fake), phone.publicKey)
  t.is(grants.openGrant(g, crypto.boxKeyPair(phone), commits), null, 'a key the decision log didn\'t commit to is ignored')
  t.absent(grants.current(g, commits))
  t.is(grants.openGrant(grants.makeGrant(real, 2, crypto.commitOf(real), phone.publicKey), crypto.boxKeyPair(phone), commits), null, 'an epoch with no commitment')
  // A rotation that lost a race (ordered second): its key stays readable, not current.
  commits.others[b4a.toString(crypto.commitOf(fake), 'hex')] = 1
  t.ok(grants.openGrant(g, crypto.boxKeyPair(phone), commits), 'the key of a rotation that lost a race still opens')
  t.absent(grants.current(g, commits), 'but is not the current one')
})

test('a sealed record opens only with its key, in its place', (t) => {
  const key = crypto.newEpochKey()
  const space = hc.randomBytes(32)
  const log = hc.randomBytes(32)
  const content = { fields: b4a.from('secret post'), links: [hc.randomBytes(33)] }
  const sealed = crypto.sealRecord(key, 3, crypto.recordAD(space, log, 7, 3), content)
  t.alike(crypto.sealedWith(sealed), { epoch: 3, commit: crypto.shortCommit(crypto.commitOf(key)) }, 'names its epoch and which key')
  t.absent(b4a.includes(sealed, b4a.from('secret post')), 'no plaintext in the bytes')
  const back = crypto.openRecord(key, crypto.recordAD(space, log, 7, 3), sealed)
  t.ok(back && b4a.equals(back.fields, content.fields) && b4a.equals(back.links[0], content.links[0]), 'opens in place')
  t.is(crypto.openRecord(key, crypto.recordAD(space, log, 8, 3), sealed), null, 'moved to another position: doesn\'t open')
  t.is(crypto.openRecord(key, crypto.recordAD(hc.randomBytes(32), log, 7, 3), sealed), null, 'in another space: doesn\'t open')
  t.is(crypto.openRecord(crypto.newEpochKey(), crypto.recordAD(space, log, 7, 3), sealed), null, 'another key: doesn\'t open')
  t.is(crypto.openRecord(key, crypto.recordAD(space, log, 7, 3), b4a.from('garbage')), null, 'garbage: null, no throw')
})
