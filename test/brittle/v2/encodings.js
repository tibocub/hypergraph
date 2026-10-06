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
