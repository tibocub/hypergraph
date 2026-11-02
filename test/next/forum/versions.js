// Story 7, FR-004, research R6: the app changes, old and new versions keep
// talking. The forum's second version added post topics (indexed) and polls;
// members still on the first one share the forum with the others. Spec 015:
// the forum records its types; every member reads, checks and indexes with
// the forum's, whatever their app declares, so an old app reads the fields
// and types it doesn't know. A new type or field is used once the owner's
// (or an admin's) updated app has opened the forum and recorded it. Any
// other change to the types is refused by the forum, naming the type and
// field; the app and its other forums keep working.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { Hypergraph } = require('../../../lib/index.js')
const { account, device } = require('./_setup.js')
const { eventually, open, tmpDir, codeOf } = require('../helpers.js')

// The forum's first version: posts without topics, no polls.
const { poll, ...firstTypes } = forum.types
const v1 = { ...firstTypes, post: { fields: { title: 'string', text: 'text' } } }
// What the first version's app wrote (its own forum.js had no topic).
const oldPost = (f, title, text) => f.put('post', { title, text })

const ids = (xs) => xs.map((x) => x.id).sort().join()

// What a member shows of the forum, the same on both versions (topics aside).
async function view (f) {
  const out = []
  for (const p of (await forum.latest(f, 50)).sort((x, y) => (x.id < y.id ? -1 : 1))) {
    out.push({ id: p.id, title: p.title, text: p.text, comments: (await forum.comments(f, p)).length, score: await forum.score(f, p) })
  }
  return JSON.stringify(out)
}

test('two versions in one forum read each other\'s records', async (t) => {
  const a = await account(t, 'a') // the new version
  const b = await account(t, 'b', { types: v1 }) // not updated yet
  const fa = await forum.createForum(a, 'Fans')
  const fb = await forum.join(b, await forum.invite(fa))

  const fresh = await forum.post(fa, 'New', 'from the new app', 'rust')
  const old = await oldPost(fb, 'Old', 'from the old app')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 2 && (await forum.latest(fb)).length === 2, 5000), 'both see both posts')
  await forum.comment(fb, fresh, 'the old app comments a new post')
  await forum.comment(fa, old, 'the new app comments an old post')
  await forum.vote(fb, fresh, 1)
  await forum.vote(fa, old, -1)

  const agreed = await eventually(async () => {
    const v = await view(fa)
    return v === (await view(fb)) && JSON.parse(v).every((p) => p.comments === 1 && p.score !== 0)
  }, 5000)
  t.ok(agreed, 'the same posts, comments and scores on both versions')

  const onOld = (await forum.latest(fb)).find((p) => p.id === fresh.id)
  t.is(onOld.text, 'from the new app')
  t.is(onOld.topic, 'rust', 'the old app reads the topic too: it reads with the forum\'s types')
  const onNew = (await forum.latest(fa)).find((p) => p.id === old.id)
  t.is(onNew.text, 'from the old app')
  t.is(onNew.topic, null, 'the new app sees it empty on an old post')
  t.is(ids(await forum.byTopic(fa, 'rust')), fresh.id, 'topics work on the new version')
  // Records without a topic (all the old app's) aren't in the topic index:
  // asking for them is an error, not an answer that differs between members.
  await t.exception(forum.byTopic(fa, null), /no value/)
})

test('a phone not updated yet edits a post: the topic it doesn\'t know stays', async (t) => {
  const laptop = await account(t, 'laptop')
  const c = await account(t, 'c')
  const fl = await forum.createForum(laptop, 'Fans')
  const fc = await forum.join(c, await forum.invite(fl))
  const { code } = await forum.addDevice(laptop)
  const phone = await device(t, 'phone', code, { types: v1 })
  t.ok(await eventually(() => forum.forums(phone).some((f) => f.key === fl.key), 15000), 'the phone shows the forum')
  const fp = phone.space(fl.key)

  const p = await forum.post(fl, 'Topics', 'v1', 'rust')
  t.ok(await eventually(async () => (await forum.latest(fp)).some((x) => x.id === p.id), 10000), 'the phone has the post')
  const edited = await eventually(async () => {
    try { return await forum.edit(fp, p, { text: 'v2' }) } catch { return null }
  }, 10000)
  t.is(edited && edited.text, 'v2', 'edited on the phone')

  for (const [name, f] of [['laptop', fl], ['c', fc]]) {
    const shown = await eventually(async () => {
      const [x] = await forum.byTopic(f, 'rust')
      return x && x.text === 'v2' ? x : null
    }, 10000)
    t.ok(shown && shown.topic === 'rust', `${name} shows the edit with its topic`)
  }
})

test('a type the forum doesn\'t have yet: refused until the owner\'s updated app records it, then read by every version', async (t) => {
  const a = await account(t, 'a', { types: v1 }) // the owner, not updated yet
  const b = await account(t, 'b', { types: v1 })
  const c = await account(t, 'c') // the new version
  const fa = await forum.createForum(a, 'Fans')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))
  const p = await oldPost(fa, 'Vote here', '')
  t.ok(await eventually(async () => (await forum.latest(fc)).length === 1, 5000), 'c has the post')
  t.is(await codeOf(forum.ask(fc, p, 'Tabs or spaces?')), 'INCOMPATIBLE_TYPES', 'the forum has no polls yet')
  t.is(await codeOf(forum.post(fc, 'Topical', '', 'meta')), 'INCOMPATIBLE_TYPES', 'nor post topics')
  t.ok((await forum.post(fc, 'No topic', '')).id, 'the new app writes what the forum has')

  // a's app is updated: opening the forum, it records the new types.
  await a.close()
  const updated = await open(t, { dir: a.dir, types: forum.types, rules: forum.rules })
  await updated.connectToSwarm()
  const fu = updated.space(fa.key)
  await fu.ready()
  t.ok(await eventually(() => fu.typesVersion === 2 && fb.typesVersion === 2 && fc.typesVersion === 2, 15000), 'every member has the forum\'s new types')
  const good = await forum.ask(fc, p, 'Tabs or spaces?')
  const topical = await forum.post(fc, 'Topical', '', 'meta')
  t.ok(await eventually(async () => ids(await forum.polls(fb, p)) === good.id, 10000), 'the old app reads the poll')
  t.ok(await eventually(async () => (await forum.latest(fb)).some((x) => x.id === topical.id && x.topic === 'meta'), 10000), 'and the topic')
  t.ok(await eventually(async () => ids(await forum.byTopic(fu, 'meta')) === topical.id, 10000), 'topics work for the owner')
  t.is(await view(fb), await view(fu), 'both versions show the same forum')
})

test('a record of a hypergraph type this version doesn\'t know (a future version\'s) is kept and counted', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b')
  const fa = await forum.createForum(a, 'Fans')
  const fb = await forum.join(b, await forum.invite(fa))
  await testing.writeRaw(fb, { kind: 'put', type: 'hg/future', fields: {} })
  const later = await forum.post(fb, 'Later', '')
  for (const [name, f] of [['a', fa], ['b', fb]]) {
    t.ok(await eventually(async () => ((await f.inspect()).records['hg/future'] || 0) === 1, 10000), `${name} keeps it, counted by type`)
    t.ok(await eventually(async () => (await f.get(later.id)).record, 10000), `${name} indexes what comes after it`)
  }
})

test('any other change to the types is refused by the forum, naming the type and the field; the app opens', async (t) => {
  const dir = tmpDir(t, 'versions')
  const first = await open(t, { dir, types: forum.types, rules: forum.rules, bootstrap: null })
  const f = await forum.createForum(first, 'Mine')
  const p = await forum.post(f, 'Kept', 'here', 'meta')
  await first.close()

  const { post, comment, vote } = forum.types
  const bad = [
    ['fields reordered', { ...forum.types, post: { ...post, fields: { text: 'text', title: 'string', topic: 'string' } } }, 'post', 'title'],
    ['a field\'s kind changed', { ...forum.types, vote: { ...vote, fields: { value: 'string', on: 'link' } } }, 'vote', 'value'],
    ['who may edit changed', { ...forum.types, post: { ...post, editable: 'members' } }, 'post', 'editable'],
    ['one per member changed', { ...forum.types, comment: { ...comment, onePerMember: true } }, 'comment', 'onePerMember'],
    ['a link field\'s targets changed', { ...forum.types, comment: { ...comment, links: { on: ['post'] } } }, 'comment', '"on"']
  ]
  for (const [what, types, ...named] of bad) {
    const hg = await Hypergraph.open(dir, { types, bootstrap: null })
    const err = await forum.latest(hg.space(f.key)).catch((e) => e)
    await hg.close()
    t.is(err && err.code, 'INCOMPATIBLE_TYPES', `${what}: ${err && err.message}`)
    t.ok(err && named.every((n) => err.message.includes(n)), `${what}: the message names ${named.join(' and ')}`)
  }
  // An older app (a field or a type fewer) is not a change: it reads the forum.
  for (const [what, types] of [['a field fewer', v1], ['a type fewer', firstTypes]]) {
    const hg = await Hypergraph.open(dir, { types, bootstrap: null })
    t.is((await forum.latest(hg.space(f.key))).length, 1, `${what}: the forum opens`)
    await hg.close()
  }

  const back = await open(t, { dir, types: forum.types, rules: forum.rules, bootstrap: null })
  const kept = back.space(f.key)
  t.is(ids(await forum.byTopic(kept, 'meta')), p.id, 'the folder opens again with the right types, unchanged')
})
