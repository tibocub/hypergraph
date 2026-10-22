// An app's own protocol on a space's connections (FR-031: SwarmFS's
// transfers), next to hypergraph's own: opened with every peer of the space,
// also when one side adds it later; each message tells who sent it.

const test = require('brittle')
const c = require('compact-encoding')
const { threeMembers } = require('../forum/_setup.js')
const { eventually } = require('../helpers.js')

// Adds 'test/hello' to `space`: says hello on open, keeps what it hears.
function hello (space, label) {
  const heard = []
  const closed = []
  space.addProtocol('test/hello', {
    messages: [{ encoding: c.string, onmessage: (text, peer) => heard.push({ text, peer }) }],
    onopen: (peer) => peer.send(0, 'hello from ' + label),
    onclose: (peer) => closed.push(peer.device)
  })
  return { heard, closed }
}

test('an app protocol is opened with every peer of the space, both ways', async (t) => {
  const { a, b, fa, fb, fc } = await threeMembers(t)
  const ha = hello(fa, 'a')
  const hb = hello(fb, 'b')
  t.ok(await eventually(() => ha.heard.some((m) => m.text === 'hello from b') && hb.heard.some((m) => m.text === 'hello from a'), 10000), 'a and b hear each other')
  const fromB = ha.heard.find((m) => m.text === 'hello from b')
  t.ok(fa.peers().some((p) => p.device === fromB.peer.device), 'the message says which device sent it')
  t.ok(await eventually(() => fromB.peer.identity === b.identity.publicKey, 5000), 'and which person')
  t.exception(() => fa.addProtocol('test/hello', {}), 'one protocol per name')

  const hc = hello(fc, 'c') // added later, with the connections already open
  t.ok(await eventually(() => hc.heard.some((m) => m.text === 'hello from a') && ha.heard.some((m) => m.text === 'hello from c'), 10000), 'a protocol added later opens too')

  await a.close()
  t.ok(await eventually(() => hb.closed.length > 0, 10000), 'onclose when the peer leaves')
})
