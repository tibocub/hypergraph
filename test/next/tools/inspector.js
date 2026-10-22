// The inspector tool (tools/inspector, ROADMAP 2026-10-09): a smoke test that
// keeps it alive next to the core. One instance with a space and a few
// records; the page and every JSON view answer with the expected shape; the
// server refuses anything but GET (read-only). Node only: the tool uses
// Node's http.

const test = require('brittle')

if (typeof Bare !== 'undefined') {
  test('inspector: skipped on Bare (the tool is Node-only for now; the core runs on both)', (t) => {
    t.comment('tools/inspector uses Node\'s http module: not run on Bare')
    t.pass('skipped on Bare')
  })
} else {
  const forum = require('../forum/forum.js')
  const { open, eventually, within } = require('../helpers.js')
  const { serveInspector } = require('../../../tools/inspector')

  test('inspector: the page and every view answer; read-only', async (t) => {
    const hg = await open(t, { label: 'inspector', types: forum.types, rules: forum.rules, bootstrap: [] })
    const f = await forum.createForum(hg, 'Inspected')
    const p = await forum.post(f, 'Hello', 'world')
    const c = await forum.comment(f, p, 'hi')
    await forum.vote(f, p, 1)
    await forum.tag(f, p, 'rust')
    await forum.edit(f, p, { text: 'world (edited)' })

    const { url, close } = await serveInspector(hg, { port: 0 })
    t.teardown(close, { order: -1 })
    const json = async (path) => {
      const res = await fetch(url + path)
      return { status: res.status, body: await res.json() }
    }

    const page = await fetch(url)
    t.is(page.status, 200)
    t.ok((await page.text()).includes('Hypergraph inspector'), 'the page')
    for (const file of ['page.js', 'page.css']) t.is((await fetch(url + file)).status, 200, file)

    const inst = (await json('api/instance')).body
    t.is(inst.identity, hg.identity.publicKey)
    t.is(inst.device, hg.device.publicKey)
    t.ok(Array.isArray(inst.devices) && inst.devices.length === 1, 'devices')
    t.ok(inst.storage.used > 0 && inst.storage.budget > 0, 'storage')
    t.alike(inst.types.comment.links, { on: ['post', 'comment'] }, 'the declared types (hg.types())')

    const spaces = (await json('api/spaces')).body
    t.is(spaces.length, 2, 'the personal space and the forum')
    t.is(spaces[0].key, 'personal')
    t.is(spaces[1].key, f.key)
    t.is(spaces[1].name, 'Inspected')
    t.is(spaces[1].members, 1)
    t.ok(spaces[1].records >= 4, 'rows')
    t.ok(Array.isArray(spaces[1].warnings))

    const space = (await json('api/space?key=' + f.key)).body
    t.is(space.key, f.key)
    t.ok(space.logs.length === 1 && space.logs[0].own, 'its own log')
    t.ok(space.decisions.length >= 1)
    t.alike(space.types, ['comment', 'post', 'vote', 'hg/tag'], 'the app\'s types first')
    t.is(space.members.length, 1)
    t.is(space.members[0].role, 'owner')
    t.is(space.members[0].you, true)
    t.is(space.members[0].banned, false, 'from space.members()')
    t.is(space.members[0].settler, true)
    t.alike(space.peerList, [], 'nobody connected (space.peers())')
    t.ok(space.recent.some((d) => d.type === 'space/init' && d.by === hg.identity.publicKey && d.counted), 'the decisions (space.decisions())')
    const decisions = (await json('api/decisions?key=' + f.key + '&limit=1')).body
    t.is(decisions.items.length, 1)
    t.is((await json('api/decisions?key=' + f.key + '&after=' + decisions.next)).body.items[0].seq, decisions.next - 1, 'paged')
    t.ok(space.roles.some((r) => r.name === 'owner'), 'roles')
    t.is(space.status.policy, 'auto')
    t.is((await json('api/space?key=personal')).body.personal, true, 'the personal space')

    const posts = (await json(`api/records?key=${f.key}&type=post`)).body
    t.is(posts.items.length, 1)
    t.is(posts.items[0].id, p.id)
    t.is(posts.items[0].edited, true)
    t.is(posts.items[0].text, 'world (edited)')
    t.is(posts.next, null)

    for (let i = 0; i < 3; i++) await forum.comment(f, p, 'more ' + i)
    const page1 = (await json(`api/records?key=${f.key}&type=comment&limit=2`)).body
    t.is(page1.items.length, 2)
    t.ok(page1.next, 'a next page')
    const page2 = (await json(`api/records?key=${f.key}&type=comment&limit=2&after=${page1.next}`)).body
    t.is(page2.items.length, 2)
    t.is(page2.items[1].id, c.id, 'paging reaches the first comment')

    const one = (await json(`api/record?key=${f.key}&id=${p.id}`)).body
    t.is(one.record.id, p.id)
    t.is(one.linked.filter((r) => r.type === 'comment').length, 4, 'what points at it')
    t.alike(one.tags, ['rust'], 'its tags (space.tags())')
    t.alike(one.history.versions.map((v) => [v.kind, v.text]), [['put', 'world'], ['edit', 'world (edited)']], 'its history (inspect({ record }))')

    // Hidden and deleted records: rows and history.
    const gone = await forum.post(f, 'Gone', '')
    await forum.remove(f, gone)
    await forum.hide(f, c, 'spam')
    const shown = (await json(`api/records?key=${f.key}&type=comment&limit=50`)).body
    t.absent(shown.items.some((r) => r.id === c.id), 'a hidden comment is left out of the list')
    const all = (await json(`api/rows?key=${f.key}&type=comment&limit=50`)).body
    t.ok(all.items.some((r) => r.id === c.id && r.state.hidden), 'and shown in all rows (inspect({ records }))')
    const deleted = (await json(`api/record?key=${f.key}&id=${gone.id}`)).body
    t.is(deleted.record, null)
    t.is(deleted.history.deleted, true, 'a deleted record: its history says so')

    t.is((await json(`api/record?key=${f.key}&id=nope`)).status, 404, 'a bad id')
    t.is((await json('api/space?key=nope')).status, 404, 'a bad space')

    // Read-only: nothing but GET.
    for (const method of ['POST', 'PUT', 'DELETE']) {
      t.is((await fetch(url + 'api/records?key=' + f.key + '&type=post', { method })).status, 405, method + ' refused')
    }

    const before = (await f.inspect()).logs[0].length
    await json('api/space?key=' + f.key)
    t.is((await f.inspect()).logs[0].length, before, 'nothing written')

    // Live: the page hears of new records and growing logs from events, with
    // no polling (the page itself has no timer).
    t.absent(require('fs').readFileSync(require('path').join(__dirname, '../../../tools/inspector/page.js'), 'utf8').includes('setInterval'), 'no polling in the page')
    const res = await fetch(url + 'api/events')
    const reader = res.body.getReader()
    const heard = (async () => {
      let text = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return false
        text += new TextDecoder().decode(value)
        if (text.includes('"logs":true')) return true
      }
    })()
    await forum.post(f, 'Another', '')
    t.ok(await within(heard, 10000), 'a logs event reaches the page')
    await reader.cancel()

    await close()
    await close()
    t.pass('close twice')
  })

  test('inspector: sub-spaces and private state, never a key', async (t) => {
    const testing = require('../../../lib/testing.js')
    const b4a = require('b4a')
    const z32 = require('z32')
    const hg = await open(t, { label: 'inspector-subs', types: forum.types, rules: forum.rules, bootstrap: [] })
    const f = await forum.createForum(hg, 'Forum')
    const general = await forum.createSubforum(f, 'General')
    const staff = await forum.createSubforum(f, 'Staff', { private: true })
    await forum.post(staff, 'secret', '')
    const { url, close } = await serveInspector(hg, { port: 0 })
    t.teardown(close, { order: -1 })
    const json = async (path) => (await fetch(url + path)).json()

    const spaces = await json('api/spaces')
    const byKey = new Map(spaces.map((s) => [s.key, s]))
    t.is(byKey.get(general.key).parent, f.key, 'a sub-space shows its parent')
    t.is(byKey.get(staff.key).private, true, 'and whether it is private')
    t.is(byKey.get(f.key).private, false)
    const forumView = await json('api/space?key=' + f.key)
    t.alike(forumView.subspaces.map((s) => s.name).sort(), ['General', 'Staff'], 'the forum lists its sub-spaces')
    t.ok(forumView.recent.some((d) => d.type === 'subspace/create' && d.name === 'Staff'), 'their creation is in its decisions')
    const staffView = await json('api/space?key=' + staff.key)
    t.is(staffView.parent, f.key)
    t.is(staffView.private, true)
    t.is(staffView.epoch, 0, 'the private sub-space\'s key epoch')
    t.is(staffView.readable, true, 'readable here')
    t.is(staffView.access, 'full', 'story 9: its access')
    t.is(forumView.reading.heldFrom, null, 'story 9: read from the beginning')
    t.ok(staffView.reading.entries >= 1, 'a sub-space with a post has its activity entries')
    t.ok(staffView.recent.some((d) => d.type === 'key/rotate'), 'its key changes are in its decisions')

    const everything = JSON.stringify([spaces, forumView, staffView, await json(`api/records?key=${staff.key}&type=post`), await json(`api/rows?key=${staff.key}&type=hg/grant`)])
    for (const k of testing.epochKeys(staff)) {
      for (const form of [b4a.toString(k, 'hex'), z32.encode(k), b4a.toString(k, 'base64')]) t.absent(everything.includes(form), 'no key in any view')
    }
    const page = require('fs').readFileSync(require('path').join(__dirname, '../../../tools/inspector/page.js'), 'utf8')
    t.ok(page.includes('subspace/create') && page.includes('key/rotate'), 'the page words the new decisions')
  })
}
