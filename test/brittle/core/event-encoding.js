const test = require('brittle')
const { encodeEvent, decodeEvent } = require('../../../src/encodings/event')

test('event-encoding: encodeEvent throws for an unregistered event type instead of silently dropping the event', async (t) => {
  // Previously, an unrecognized event.type (a typo, or a new type added
  // elsewhere without updating EVENT_TYPES here) silently encoded as
  // typeCode 0 with none of the type's real fields — decode then handed
  // back only `{ type: undefined, timestamp }`, permanently losing every
  // other field with no error anywhere to say why.
  console.log('TEST: encodeEvent rejects unknown type - starting')

  t.exception(
    () => encodeEvent({ type: 'entity/create ', id: 'x', entityType: 'post', author: 'a'.repeat(64), timestamp: Date.now() }),
    /Unknown event type/,
    'a trailing-space typo in the type string is rejected, not silently accepted'
  )

  t.exception(
    () => encodeEvent({ type: 'not/a/real/type', timestamp: Date.now() }),
    /Unknown event type/,
    'a completely made-up type string is rejected'
  )

  t.execution(
    () => encodeEvent({ type: 'entity/create', id: 'post/a'.repeat(9), entityType: 'post', author: 'a'.repeat(64), timestamp: Date.now() }),
    'a genuinely registered type still encodes without error'
  )
  console.log('TEST: encodeEvent rejects unknown type - passed')
})

test('event-encoding: decodeEvent never throws on malformed/truncated bytes', async (t) => {
  // decodeEvent is wired directly into Autobase's apply loop
  // (context-base.js) and UserCore's read paths with no wrapping try/catch
  // anywhere in the call chain — a single corrupted or truncated event
  // block from any writer must not crash the process (Constitution
  // Principle I: "no crash on malformed or adversarial input from a peer").
  console.log('TEST: decodeEvent malformed input - starting')

  const good = encodeEvent({ type: 'entity/create', id: 'post/a'.repeat(9), entityType: 'post', author: 'a'.repeat(64), timestamp: Date.now() })

  // Truncated mid-field: cuts off partway through the id string, which
  // compact-encoding's c.string.decode reads via a length-prefixed varint —
  // truncating like this makes it try to read past the end of the buffer.
  const truncated = good.subarray(0, Math.floor(good.length / 2))

  let decoded
  t.execution(() => { decoded = decodeEvent(truncated) }, 'decoding a truncated buffer does not throw')
  t.ok(decoded && typeof decoded === 'object', 'a truncated buffer still returns a safe object, not null (null means "no buffer" to callers, not "corrupted")')
  t.absent(decoded.type, 'the safe fallback has no matchable type, so every downstream type-based switch/if-chain skips it exactly like an unrecognized type')

  // Corrupted length prefix: flip a byte partway through so the encoded
  // varint length no longer matches what's actually in the buffer.
  const corrupted = Buffer.from(good)
  corrupted[Math.floor(corrupted.length / 2)] = 0xff
  t.execution(() => decodeEvent(corrupted), 'decoding a corrupted buffer does not throw')

  t.is(decodeEvent(null), null, 'a falsy buffer still returns null, unchanged from before')

  const roundTrip = decodeEvent(good)
  t.is(roundTrip.type, 'entity/create', 'a genuinely valid buffer still round-trips correctly')
  console.log('TEST: decodeEvent malformed input - passed')
})
