// A peer opening hypergraph's space protocol (or an older version's) without a
// channel id ended the other side's process: comparing keys with a null id
// threw inside Protomux, whose catch rethrows TypeErrors.

const test = require('brittle')
const { threeMembers } = require('../forum/_setup.js')
const { eventually, sleep } = require('../helpers.js')
const { PROTOCOL, OTHER_PROTOCOLS } = require('../../../lib/directory.js')

test('a channel without an id is turned down, nothing crashes', async (t) => {
  const { a, b, fa } = await threeMembers(t)
  const conn = await eventually(() => [...b._network.connections].find((x) => x.remotePublicKey.equals(a._identity.device.publicKey)), 10000)
  t.ok(conn, 'b is connected to a')
  for (const protocol of [PROTOCOL, ...OTHER_PROTOCOLS]) {
    const ch = conn.userData.createChannel({ protocol, id: null })
    t.ok(ch, 'a channel without an id: ' + protocol)
    ch.open()
  }
  await sleep(1000)
  t.ok(await fa.put('post', { title: 'still here', text: '' }), 'a keeps working')
})
