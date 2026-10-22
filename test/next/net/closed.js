// A closed forum stays closed (audit 1): the topic members meet on (the
// space's discovery key) is seen by DHT nodes, and must not be enough to read
// the space. A peer that knows only the topic opens the space channel and asks
// for the log list and activity lists: it gets no log key, and its channel is
// closed; the members still sync.

const test = require('brittle')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const forum = require('../forum/forum.js')
const activity = require('../../../lib/activity.js')
const { PROTOCOL } = require('../../../lib/directory.js')
const { threeMembers } = require('../forum/_setup.js')
const { eventually, testBootstrap } = require('../helpers.js')

// A spy on the topic: opens the space channel (with `guess` as its handshake,
// or none, as an honest peer of the old protocol) and asks for every log key.
// Returns what it got: { got (kinds of messages carrying log keys: 2 list,
// 3 notice, 8 entry, 10 activity list), closed }.
async function spy (t, space, guess) {
  const swarm = new Hyperswarm({ bootstrap: await testBootstrap(t) })
  const out = { got: [], closed: 0 }
  swarm.on('connection', (conn) => {
    conn.on('error', () => {})
    conn.on('close', () => { out.closed++ })
    const ch = Protomux.from(conn).createChannel({
      protocol: PROTOCOL,
      id: space.discoveryKey,
      handshake: guess ? c.fixed32 : null,
      onopen () {
        ch.messages[1].send(null) // want: the log list
        ch.messages[9].send({ from: 0 }) // the activity lists from the start
      },
      onclose () { out.closed++ }
    })
    if (!ch) return
    for (let i = 0; i <= 10; i++) {
      const encoding = i === 1 ? c.none : i === 9 ? activity.want : c.raw
      ch.addMessage({ encoding, onmessage: () => { if ([2, 3, 8, 10].includes(i)) out.got.push(i) } })
    }
    ch.open(guess)
  })
  const discovery = swarm.join(space.discoveryKey, { server: false, client: true })
  t.teardown(async () => { // force skips the topic's teardown, whose refresh timer would keep the process alive
    await swarm.destroy({ force: true })
    await discovery.destroy()
  }, { order: 0 })
  return out
}

for (const [name, guess] of [['no capability', null], ['a guessed capability', crypto.randomBytes(32)]]) {
  test(`a peer knowing only the topic (${name}) gets no log key; the members still sync`, { timeout: 60000 }, async (t) => {
    const { fa, fb } = await threeMembers(t)
    await forum.post(fa, 'members only', '')
    const s = await spy(t, fa, guess)
    t.ok(await eventually(() => s.closed > 0 || s.got.length > 0, 20000), 'the spy reached a member')
    t.alike(s.got, [], 'no log key reached it')
    t.ok(s.closed > 0, 'its space channel (or connection) was closed')

    const p = await forum.post(fa, 'still syncing', '')
    t.ok(await eventually(async () => !!(await fb.get(p.id)).record, 10000), 'a member still gets new posts')
  })
}
