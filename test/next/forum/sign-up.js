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

// Every readable file under `dir`, as one string per file (to look for the phrase on disk).
function filesUnder (dir) {
  const fs = require('fs')
  const path = require('path')
  const out = []
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name)
    if (fs.statSync(full).isDirectory()) out.push(...filesUnder(full))
    else try { out.push(fs.readFileSync(full).toString('latin1')) } catch {} // locked while open
  }
  return out
}
const onDisk = (dir, phrase) => filesUnder(dir).some((s) => s.includes(phrase))

test('the person may have the phrase forgotten: gone from the device, the identity stays', async (t) => {
  const first = await account(t, 'forget')
  const phrase = await forum.recoveryPhrase(first)
  const identity = first.identity.publicKey
  t.ok(onDisk(first.dir, phrase), 'kept on the device until the person chooses')

  await forum.forgetPhrase(first)
  t.is(await forum.recoveryPhrase(first), null, 'gone at once')
  await first.close()
  t.absent(onDisk(first.dir, phrase), 'and from the folder')

  const again = await account(t, 'forget-again', { dir: first.dir })
  t.is(again.identity.publicKey, identity, 'the device keeps its identity without the phrase')
  t.is(await forum.recoveryPhrase(again), null)
  const elsewhere = await account(t, 'forget-elsewhere', { phrase })
  t.is(elsewhere.identity.publicKey, identity, 'the written-down phrase still restores it elsewhere')
})

test('the person may protect the phrase with a password', async (t) => {
  const first = await account(t, 'protect')
  const phrase = await forum.recoveryPhrase(first)
  await forum.protectPhrase(first, 'correct horse')
  await t.exception(forum.recoveryPhrase(first), /password/, 'needs the password')
  try { await forum.recoveryPhrase(first, 'wrong') } catch (err) { t.is(err.code, 'NOT_ALLOWED', 'a wrong password is refused') }
  t.is(await forum.recoveryPhrase(first, 'correct horse'), phrase)
  await first.close()
  t.absent(onDisk(first.dir, phrase), 'not in the folder in plain text')

  const again = await account(t, 'protect-again', { dir: first.dir })
  t.is(await forum.recoveryPhrase(again, 'correct horse'), phrase, 'after a restart too')
  await forum.forgetPhrase(again)
  t.is(await forum.recoveryPhrase(again, 'correct horse'), null, 'a protected phrase can be forgotten too')
})

// Story 4 (ROADMAP 2026-10-09, research.md A7): the phrase protected from the first moment.
test('opened with a password, the phrase is never in the folder in plain text', async (t) => {
  const first = await account(t, 'sealed', { password: 'correct horse' })
  const phrase = await forum.recoveryPhrase(first, 'correct horse')
  t.is(phrase.split(' ').length, 24, 'the app shows it with the password')
  t.absent(onDisk(first.dir, phrase), 'never written in plain text')
  await t.exception(forum.recoveryPhrase(first), /password/, 'needs the password')

  const elsewhere = await account(t, 'sealed-restore', { phrase, password: 'other' })
  t.is(elsewhere.identity.publicKey, first.identity.publicKey)
  t.absent(onDisk(elsewhere.dir, phrase), 'restored with a password: sealed too')
  t.is(await forum.recoveryPhrase(elsewhere, 'other'), phrase)
})
