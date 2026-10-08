// Story 1 #7: a new account gets a recovery phrase that restores the same
// identity on another computer.

const test = require('brittle')
const forum = require('./forum.js')
const { account } = require('./_setup.js')

test('a new account gets a recovery phrase that restores it elsewhere', async (t) => {
  const laptop = await account(t, 'laptop')
  const phrase = await forum.recoveryPhrase(laptop)
  t.is(phrase.split(' ').length, 24, 'a 24-word phrase')
  t.is(typeof laptop.identity.publicKey, 'string')

  const desktop = await account(t, 'desktop', { phrase })
  t.is(desktop.identity.publicKey, laptop.identity.publicKey, 'the same person')
  t.not(desktop.device.publicKey, laptop.device.publicKey, 'another device')
})

test('reopening the same folder keeps the identity and its phrase', async (t) => {
  const first = await account(t, 'first')
  const phrase = await forum.recoveryPhrase(first)
  const identity = first.identity.publicKey
  await first.close()
  const again = await account(t, 'again', { dir: first.dir })
  t.is(again.identity.publicKey, identity)
  t.is(await forum.recoveryPhrase(again), phrase)
})
