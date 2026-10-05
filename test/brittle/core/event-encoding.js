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

test('event-encoding: context/init carries an optional index layout, with or without an owner (spec 002)', async (t) => {
  const owner = 'a'.repeat(64)
  const v3 = { type: 'context/init', version: 3, rules: 'x', owner, layout: 2, timestamp: 4 }
  t.alike(decodeEvent(encodeEvent(v3)), v3, 'owner and layout')
  const v2 = { type: 'context/init', version: 2, rules: '', layout: 2, timestamp: 4 }
  t.alike(decodeEvent(encodeEvent(v2)), v2, 'layout without an owner: no owner comes back')
  const old = { type: 'context/init', version: 3, rules: '', owner, timestamp: 4 }
  t.absent('layout' in decodeEvent(encodeEvent(old)), 'records from before layouts decode without one')
})

test('event-encoding: invites and redemptions carry an optional scope request; old ones keep their bytes (spec 006 US3)', async (t) => {
  const { stableContextHash } = require('../../../src/utils')
  const a = 'a'.repeat(64)
  const sig = 'c'.repeat(128)
  const plainInvite = { type: 'context/invite', inviteKey: a, role: 'member', uses: 1, author: a, timestamp: 1, signature: sig }
  const scoped = { ...plainInvite, scope: 'private', scopeBase: 'd'.repeat(64), roleBase: 'e'.repeat(64) }
  t.alike(decodeEvent(encodeEvent(scoped)), scoped, 'scoped invite round-trips')
  t.alike(decodeEvent(encodeEvent(plainInvite)), plainInvite, 'plain invite round-trips without scope fields')
  t.ok(encodeEvent(scoped).length > encodeEvent(plainInvite).length, 'scope fields are extra bytes, not a new layout')

  const plainRedeem = { type: 'context/redeem', inviteKey: a, member: a, key: 'b'.repeat(64), timestamp: 1, signature: sig, memberSignature: sig }
  const withKey = { ...plainRedeem, encryptionKey: 'f'.repeat(64) }
  t.alike(decodeEvent(encodeEvent(withKey)), withKey, 'redemption with an encryption key round-trips')
  t.alike(decodeEvent(encodeEvent(plainRedeem)), plainRedeem, 'plain redemption round-trips without one')

  // Signed: changing the requested scope or the encryption key changes the digest,
  // and plain events hash exactly as before.
  t.unlike(stableContextHash(scoped, a), stableContextHash({ ...scoped, scope: 'other' }, a), 'scope is signed')
  t.unlike(stableContextHash(withKey, a), stableContextHash({ ...withKey, encryptionKey: '0'.repeat(64) }, a), 'encryption key is signed')
  t.alike(stableContextHash(plainRedeem, a), stableContextHash({ ...plainRedeem }, a))
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

test('event-encoding: relation/create carries optional data; without it the bytes are unchanged (spec 004)', async (t) => {
  const a = 'a'.repeat(64)
  const base = { type: 'relation/create', from: `file/${a}/1`, to: `dir/${a}/0`, relationType: 'in', author: a, timestamp: 1791000000000, signature: 'c'.repeat(128) }

  const withData = { ...base, data: '{"name":"song.mp3","root":"ab12","size":4096}' }
  t.alike(decodeEvent(encodeEvent(withData)), { ...withData, value: undefined }, 'data round-trips')

  const both = { ...base, value: 2.5, data: 'x' }
  t.alike(decodeEvent(encodeEvent(both)), both, 'data and value together')

  const plain = encodeEvent(base)
  const plainWithUndefined = encodeEvent({ ...base, data: undefined })
  t.alike(plainWithUndefined, plain, 'no data: identical bytes')
  t.absent('data' in decodeEvent(plain), 'no data field when there is none')

  // What an older decoder sees: it stops after the value fields.
  const withDataBytes = encodeEvent(withData)
  const old = decodeEvent(withDataBytes.subarray(0, plain.length))
  t.is(old.from, base.from, 'the fields before data still decode')
  t.absent(old.data, 'and data is simply not there')
})

test('event-encoding: context/writer, context/role and context/upgrade round-trip; context/init carries an optional owner (spec 005)', async (t) => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const sig = 'c'.repeat(128)
  const writer = { type: 'context/writer', key: b, member: a, author: a, timestamp: 1, signature: sig }
  t.alike(decodeEvent(encodeEvent(writer)), writer, 'context/writer')
  const noMember = { type: 'context/writer', key: b, member: '', author: a, timestamp: 1, signature: sig }
  t.alike(decodeEvent(encodeEvent(noMember)), noMember, 'context/writer without member')
  const role = { type: 'context/role', member: b, role: 'admin', author: a, timestamp: 2, signature: sig }
  t.alike(decodeEvent(encodeEvent(role)), role, 'context/role')
  const removal = { type: 'context/role', member: b, role: '', author: a, timestamp: 2, signature: sig }
  t.alike(decodeEvent(encodeEvent(removal)), removal, 'context/role removal')
  const upgrade = { type: 'context/upgrade', version: 3, owner: a, timestamp: 3 }
  t.alike(decodeEvent(encodeEvent(upgrade)), upgrade, 'context/upgrade')

  const init3 = { type: 'context/init', version: 3, rules: 'x', owner: a, timestamp: 4 }
  t.alike(decodeEvent(encodeEvent(init3)), init3, 'context/init with owner')
  const init2 = { type: 'context/init', version: 2, rules: '', timestamp: 4 }
  t.alike(decodeEvent(encodeEvent(init2)), init2, 'context/init without owner keeps its old bytes and shape')
})

test('event-encoding: context/invite and context/redeem round-trip (spec 006)', async (t) => {
  const a = 'a'.repeat(64)
  const b = 'b'.repeat(64)
  const sig = 'c'.repeat(128)
  const invite = { type: 'context/invite', inviteKey: b, role: 'admin', uses: 3, author: a, timestamp: 1, signature: sig }
  t.alike(decodeEvent(encodeEvent(invite)), invite, 'context/invite')
  const revoke = { type: 'context/invite', inviteKey: b, role: 'admin', uses: 0, author: a, timestamp: 2, signature: sig }
  t.alike(decodeEvent(encodeEvent(revoke)), revoke, 'revocation (uses: 0)')
  const redeem = { type: 'context/redeem', inviteKey: b, member: a, key: 'd'.repeat(64), timestamp: 3, signature: sig, memberSignature: 'e'.repeat(128) }
  t.alike(decodeEvent(encodeEvent(redeem)), redeem, 'context/redeem')
})
