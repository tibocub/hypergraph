// Join codes (research R9, A7): a device already in shows a code; a new
// device opened with it becomes a device of the same identity, over the
// local DHT. A code works once; a used code, a wrong one, or a folder that
// already holds an identity is refused.

const test = require('brittle')
const { open, tmpDir, testBootstrap } = require('../helpers.js')
const { Hypergraph } = require('../../../lib/index.js')

test('a join code adds a device once; used again or wrong, it is refused', async (t) => {
  const a = await open(t, { label: 'a' })
  await a.connectToSwarm()
  const { code, added } = await a.addDevice()
  t.is(typeof code, 'string')
  t.ok(code.length < 200, `short enough for a QR code or pasting (${code.length} characters)`)

  const b = await open(t, { label: 'b', joinCode: code })
  t.is(b.identity.publicKey, a.identity.publicKey, 'the same identity')
  t.is((await added).publicKey, b.device.publicKey)

  const bootstrap = await testBootstrap(t)
  await t.exception(Hypergraph.open(tmpDir(t, 'c'), { joinCode: code, joinTimeout: 4000, bootstrap }), /INVITE_INVALID/, 'a used code is refused')
  await t.exception(Hypergraph.open(tmpDir(t, 'd'), { joinCode: 'not a code', bootstrap }), /INVITE_INVALID/, 'a wrong code at once')
  await a.close()
  await t.exception(Hypergraph.open(a.dir, { joinCode: code, bootstrap }), /NOT_ALLOWED/, 'a folder that holds an identity')
})

test('a code nobody uses expires: added resolves to null', async (t) => {
  const a = await open(t, { label: 'a' })
  const { added } = await a.addDevice({ timeout: 500 })
  t.is(await added, null)
})

test('a protected phrase needs its password to add a device', async (t) => {
  const a = await open(t, { label: 'a' })
  await a.protectRecoveryPhrase('secret')
  await t.exception(a.addDevice(), /NOT_ALLOWED|password/)
  const { added } = await a.addDevice({ password: 'secret', timeout: 100 })
  t.is(await added, null)
})
