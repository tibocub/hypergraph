// Story 7, FR-004, research R6: the app changes, old and new versions keep
// talking. The forum's second version added post topics (indexed) and polls;
// members still on the first one share the forum with the others. Each reads
// the other's records, an old app's edit keeps the fields it doesn't know,
// records of types it doesn't know are kept and shown once it learns them,
// and members never disagree on what exists (constitution Principle I). Any
// other change to the types is refused at open, naming the type and field.

const test = require('brittle')
const forum = require('./forum.js')
const testing = require('../../../lib/testing.js')
const { Hypergraph } = require('../../../lib/index.js')
const { account, device } = require('./_setup.js')
const { eventually, open, tmpDir } = require('../helpers.js')

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
  t.absent('topic' in onOld, 'the old app ignores the field it doesn\'t know')
  const onNew = (await forum.latest(fa)).find((p) => p.id === old.id)
  t.is(onNew.text, 'from the old app')
  t.is(onNew.topic, null, 'the new app sees it empty on an old post')
  t.is(ids(await forum.byTopic(fa, 'rust')), fresh.id, 'topics work on the new version')
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

test('records of a type the app doesn\'t know are kept, and shown once it learns the type', async (t) => {
  const a = await account(t, 'a')
  const b = await account(t, 'b', { types: v1 })
  const c = await account(t, 'c') // the new version, misbehaving later
  const fa = await forum.createForum(a, 'Fans')
  const fb = await forum.join(b, await forum.invite(fa))
  const fc = await forum.join(c, await forum.invite(fa))

  const p = await forum.post(fa, 'Vote here', '', 'meta')
  const cm = await forum.comment(fa, p, 'a comment')
  const good = await forum.ask(fa, p, 'Tabs or spaces?')
  t.ok(await eventually(async () => (await forum.comments(fc, p)).length === 1, 5000), 'c has the comment')
  // c's app is modified: a poll under a comment (polls go under posts).
  await testing.writeRaw(fc, { kind: 'put', type: 'poll', fields: { question: 'bad', on: cm.id } })
  const after = await forum.post(fc, 'Later', '', 'meta')

  const polls = async (f) => (await f.inspect()).records.poll || 0
  t.ok(await eventually(async () => (await forum.latest(fb)).length === 2 && (await polls(fb)) === 2, 5000), 'the old app keeps both polls, by type')
  t.ok(await eventually(async () => (await forum.latest(fa)).length === 2, 5000), 'a has c\'s later post')
  t.is(await polls(fa), 1, 'the new app refused the bad poll')
  t.is(ids(await forum.polls(fa, p)), good.id)
  t.exception(() => fb.query('poll'), /Unknown type "poll"/, 'the old app can\'t read polls')
  const before = await view(fa)
  t.is(await view(fb), before, 'both versions show the same posts')

  // b's app is updated: the same folder, opened with the new types.
  await b.close()
  const updated = await open(t, { dir: b.dir, types: forum.types, rules: forum.rules, readTimeout: 200 })
  const fu = updated.space(fa.key)
  t.ok(await eventually(async () => ids(await forum.polls(fu, p)) === good.id && (await polls(fu)) === 1, 10000), 'the poll is shown, the bad one refused')
  t.ok(await eventually(async () => ids(await forum.byTopic(fu, 'meta')) === ids([p, after]), 10000), 'posts received while it was old are found by topic')
  t.is(await view(fu), before, 'the same forum as the others')
  await updated.close()

  const again = await open(t, { dir: b.dir, types: forum.types, rules: forum.rules, readTimeout: 200 })
  const fg = again.space(fa.key)
  t.is(ids(await forum.polls(fg, p)), good.id, 'restarted: the same')
  t.is(testing.indexedBlocks(fg), 0, 'and nothing indexed again')
})

test('any other change to the types is refused at open, naming the type and the field', async (t) => {
  const dir = tmpDir(t, 'versions')
  const first = await open(t, { dir, types: forum.types, rules: forum.rules, bootstrap: null })
  const f = await forum.createForum(first, 'Mine')
  const p = await forum.post(f, 'Kept', 'here', 'meta')
  await first.close()

  const { post, comment, vote } = forum.types
  const bad = [
    ['fields reordered', { ...forum.types, post: { ...post, fields: { text: 'text', title: 'string', topic: 'string' } } }, 'post', 'title'],
    ['a field\'s kind changed', { ...forum.types, vote: { ...vote, fields: { value: 'string', on: 'link' } } }, 'vote', 'value'],
    ['a field removed (the old version on a folder the new one opened)', v1, 'post', 'topic'],
    ['a type removed', firstTypes, 'poll'],
    ['who may edit changed', { ...forum.types, post: { ...post, editable: 'members' } }, 'post', 'editable'],
    ['one per member changed', { ...forum.types, comment: { ...comment, onePerMember: true } }, 'comment', 'onePerMember'],
    ['a link field\'s targets changed', { ...forum.types, comment: { ...comment, links: { on: ['post'] } } }, 'comment', '"on"']
  ]
  for (const [what, types, ...named] of bad) {
    let err = null
    try { await (await Hypergraph.open(dir, { types, bootstrap: null })).close() } catch (e) { err = e }
    t.is(err && err.code, 'INCOMPATIBLE_TYPES', `${what}: ${err && err.message}`)
    t.ok(err && named.every((n) => err.message.includes(n)), `${what}: the message names ${named.join(' and ')}`)
  }

  const back = await open(t, { dir, types: forum.types, rules: forum.rules, bootstrap: null })
  const kept = back.space(f.key)
  t.is(ids(await forum.byTopic(kept, 'meta')), p.id, 'the folder opens again with the right types, unchanged')
})
