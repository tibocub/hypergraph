// v2 prototype: an author's per-channel log (spec 007, research R5).

const test = require('brittle')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const { AuthorLog } = require('../../../src/v2/author-log')
const { tmpStore, sleep } = require('./_helpers')

const community = b4a.alloc(32, 1)

test('v2 author log: the same identity derives the same log key in another store', async (t) => {
  const identity = { keyPair: crypto.keyPair() }
  const a = AuthorLog.keyPairFor(identity, community, 'general')
  const b = AuthorLog.keyPairFor(identity, community, 'general')
  t.alike(a.publicKey, b.publicKey, 'deterministic')
  t.unlike(a.publicKey, AuthorLog.keyPairFor(identity, community, 'other').publicKey, 'one log per channel')
  t.unlike(a.publicKey, AuthorLog.keyPairFor({ keyPair: crypto.keyPair() }, community, 'general').publicKey, 'one log per author')

  const { store: s1 } = tmpStore(t, 'alog-1')
  const { store: s2 } = tmpStore(t, 'alog-2')
  const l1 = new AuthorLog(s1, { keyPair: a })
  const l2 = new AuthorLog(s2, { keyPair: b })
  await l1.ready(); await l2.ready()
  t.alike(l1.key, l2.key, 'opened in two stores, same log')
  await l1.close(); await l2.close()
})

test('v2 author log: posts append with non-decreasing times and read back; a reader by key sees them', async (t) => {
  const identity = { keyPair: crypto.keyPair() }
  const { store } = tmpStore(t, 'alog-w')
  const log = new AuthorLog(store, { keyPair: AuthorLog.keyPairFor(identity, community, 'general') })
  await log.ready()
  t.teardown(() => log.close())
  const first = await log.append({ text: 'one' })
  const second = await log.append({ text: 'two', reply: { log: log.key, seq: first.seq } })
  t.is(first.seq, 0)
  t.is(second.seq, 1)
  t.ok(second.t >= first.t, 'times never go back')
  t.alike((await log.get(1)).reply, { log: log.key, seq: 0 })

  const { store: rs } = tmpStore(t, 'alog-r')
  const s1 = store.replicate(true); const s2 = rs.replicate(false); s1.pipe(s2).pipe(s1)
  t.teardown(() => { s1.destroy(); s2.destroy() })
  const reader = new AuthorLog(rs, { key: log.key })
  await reader.ready()
  t.teardown(() => reader.close())
  for (let i = 0; i < 100 && reader.length < 2; i++) { await reader.update(); await sleep(20) }
  t.alike((await reader.tail(2)).map(m => m.text), ['two', 'one'], 'tail, newest first')
})

test('v2 author log: shown times never go backwards even if a block claims an earlier time', async (t) => {
  const { store } = tmpStore(t, 'alog-skew')
  const log = new AuthorLog(store, { keyPair: crypto.keyPair() })
  await log.ready()
  t.teardown(() => log.close())
  await log.appendRaw({ t: 1000, text: 'a' })
  await log.appendRaw({ t: 500, text: 'b' }) // a buggy or hostile client
  const shown = await log.range(0, 2)
  t.alike(shown.map(m => m.t), [1000, 1000], 'shown at its predecessor\'s time')
})
