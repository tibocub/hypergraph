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

test('event-encoding: a context stores exactly encodeEvent(event) in its oplog, for every event type', async (t) => {
  // Guards FR-021 of spec 002: hypergraph now hands Autobase pre-encoded
  // bytes instead of letting Autobase run our codec, so batched appends
  // work. The bytes in the oplog (what replicates to every peer, including
  // peers on older versions) must be exactly what they were before.
  const { createGraph } = require('../helpers')
  const { graph } = await createGraph(t, 'oplog-bytes')
  const ctx = await graph.createContext()
  const context = await graph.openContext(ctx)

  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const sig = 'c'.repeat(128)
  const ts = 1791000000000
  const events = [
    { type: 'relation/create', from: `post/${a}/0`, to: `post/${b}/1`, relationType: 'reply', author: a, timestamp: ts, signature: sig },
    { type: 'relation/create', from: `post/${a}/0`, to: `post/${b}/2`, relationType: 'vote', author: a, timestamp: ts, signature: sig, value: 1.5 },
    { type: 'relation/delete', from: `post/${a}/0`, to: `post/${b}/1`, relationType: 'reply', author: a, createdAt: ts, timestamp: ts + 1, signature: sig },
    { type: 'tag/add', entityId: `post/${a}/0`, tag: 'news', author: a, timestamp: ts, signature: sig },
    { type: 'tag/remove', entityId: `post/${a}/0`, tag: 'news', author: a, timestamp: ts, signature: sig },
    { type: 'moderation/action', version: 1, action: 'content.flag', target: `post/${b}/1`, reason: 'spam', context: ctx, author: a, timestamp: ts, signature: sig },
    { type: 'message', text: 'hello', username: 'alice', author: a, timestamp: ts },
    { type: 'roles/addWriter', key: b, timestamp: ts }
  ]

  const start = context.base.local.length
  for (const event of events) await context.append(event)

  for (let i = 0; i < events.length; i++) {
    const block = await context.base.local.get(start + i)
    t.alike(block.node.value, encodeEvent(events[i]), `${events[i].type} (#${i}) is stored as encodeEvent() output`)
  }
})

test('event-encoding: context/init round-trips (spec 003)', async (t) => {
  const event = { type: 'context/init', version: 2, rules: 'swarmfs/v1', timestamp: 1791000000000 }
  t.alike(decodeEvent(encodeEvent(event)), event, 'version and rules survive')

  const plain = { type: 'context/init', version: 2, rules: '', timestamp: 1 }
  t.alike(decodeEvent(encodeEvent(plain)), plain, 'empty rules id survives')
})

test('event-encoding: an event type this version does not know decodes to { type: undefined } without throwing', async (t) => {
  // What an older peer does with context/init, and what this peer does with
  // a type added after it — the reason mixed versions in one context are
  // unsupported rather than silently wrong (spec 003, research R3).
  const c = require('compact-encoding')
  const state = { start: 0, end: 0, buffer: null }
  c.uint.preencode(state, 200); c.uint.preencode(state, 5); c.string.preencode(state, 'future')
  state.buffer = Buffer.alloc(state.end)
  c.uint.encode(state, 200); c.uint.encode(state, 5); c.string.encode(state, 'future')
  const decoded = decodeEvent(state.buffer)
  t.is(decoded.type, undefined, 'unknown type')
  t.is(decoded.timestamp, 5, 'common fields still read')
})
