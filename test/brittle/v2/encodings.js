// v2 prototype: wire formats (spec 007, data-model.md).

const test = require('brittle')
const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const { message, rosterValue, announcement, rosterSignable, MAX_TEXT } = require('../../../src/v2/encodings')

const key = (n) => b4a.alloc(32, n)

test('v2 encodings: a message round-trips, with and without a reply', (t) => {
  const plain = { t: 1791000000000, text: 'hello' }
  t.alike(message.decode(message.encode(plain)), plain)
  const reply = { t: 5, text: 're', reply: { log: key(7), seq: 3 } }
  t.alike(message.decode(message.encode(reply)), reply)
})

test('v2 encodings: text over the limit is refused', (t) => {
  t.exception(() => message.encode({ t: 1, text: 'x'.repeat(MAX_TEXT + 1) }), /too long/)
  t.execution(() => message.encode({ t: 1, text: 'x'.repeat(MAX_TEXT) }))
})

test('v2 encodings: roster values and announcements round-trip', (t) => {
  const v = { log: key(1), start: 42, sig: b4a.alloc(64, 9) }
  t.alike(rosterValue.decode(rosterValue.encode(v)), v)
  const a = { channel: 'general', segment: 12, author: key(2), log: key(3), start: 0, sig: b4a.alloc(64, 1) }
  t.alike(announcement.decode(announcement.encode(a)), a)
})

test('v2 encodings: the roster signature covers community, channel, segment, log and start', (t) => {
  const kp = crypto.keyPair()
  const base = [key(1), 'general', 3, key(4), 10]
  const sig = crypto.sign(rosterSignable(...base), kp.secretKey)
  t.ok(crypto.verify(rosterSignable(...base), sig, kp.publicKey))
  for (let i = 0; i < base.length; i++) {
    const changed = [...base]
    changed[i] = typeof base[i] === 'number' ? base[i] + 1 : typeof base[i] === 'string' ? base[i] + 'x' : key(99)
    t.absent(crypto.verify(rosterSignable(...changed), sig, kp.publicKey), `changing field ${i} breaks it`)
  }
})

test('v2 encodings: a private message block round-trips and is told apart from a plain one', (t) => {
  const { isSealed } = require('../../../src/v2/encodings')
  const sealed = { t: 1791000000000, epoch: 2, nonce: b4a.alloc(24, 1), box: b4a.alloc(40, 2) }
  const back = message.decode(message.encode(sealed))
  t.alike(back, sealed)
  t.ok(isSealed(back))
  t.absent(isSealed(message.decode(message.encode({ t: 1, text: 'x' }))))
  const { sealedContent } = require('../../../src/v2/encodings')
  const inner = { text: 'secret', reply: { log: key(4), seq: 9 } }
  t.alike(sealedContent.decode(sealedContent.encode(inner)), inner, 'what goes in the box round-trips')
  t.exception(() => sealedContent.encode({ text: 'x'.repeat(MAX_TEXT + 1) }), /too long/)
})

test('v2 encodings: grants, invites and redemptions round-trip', (t) => {
  const { grantKey, grantValue, grantSubmission, invite, redemption } = require('../../../src/v2/encodings')
  t.alike(grantKey.decode(grantKey.encode([key(1), 7])), [key(1), 7])
  const g = { identity: key(13), sealed: b4a.alloc(80, 3), granter: key(2), sig: b4a.alloc(64, 4) }
  t.alike(grantValue.decode(grantValue.encode(g)), g)
  const s = { channel: 'c', recipient: key(5), epoch: 1, ...g }
  t.alike(grantSubmission.decode(grantSubmission.encode(s)), s)
  const full = { id: b4a.alloc(16, 6), community: key(7), role: 'mod', channels: ['a', 'b'], expires: 1791000000000, uses: 3, maker: key(8), sig: b4a.alloc(64, 9) }
  t.alike(invite.decode(invite.encode(full)), full)
  const bare = { id: b4a.alloc(16, 6), community: key(7), role: null, channels: [], expires: 0, uses: 0, maker: key(8), sig: b4a.alloc(64, 9) }
  t.alike(invite.decode(invite.encode(bare)), bare)
  const r = { invite: full, identity: key(10), encryptionKey: key(11), writer: key(12), t: 5, sig: b4a.alloc(64, 1) }
  t.alike(redemption.decode(redemption.encode(r)), r)
  const r2 = { ...r, writer: null }
  t.alike(redemption.decode(redemption.encode(r2)), r2)
})
