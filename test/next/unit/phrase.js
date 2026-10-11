// The recovery phrase on this device (lib/phrase.js) and the logs file
// (lib/instance.js): readable only by the folder's owner (audit 2), and a crash
// never leaves them broken (audits 6, 7). File modes are checked on Linux and
// macOS; Windows ignores them (the folder's permissions apply).

const test = require('brittle')
const fs = require('fs')
const os = require('os')
const path = require('path')
const b4a = require('b4a')
const phrase = require('../../../lib/phrase.js')
const instance = require('../../../lib/instance.js')
const { tmpDir, open } = require('../helpers.js')

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
const posix = os.platform() !== 'win32'
const modeOf = (file) => fs.statSync(file).mode & 0o777

test('the phrase file is readable by its owner only', { skip: !posix }, (t) => {
  const dir = tmpDir(t)
  fs.writeFileSync(path.join(dir, 'recovery-phrase.tmp'), 'left by a crash') // created with the default mode
  phrase.save(dir, WORDS)
  t.is(modeOf(path.join(dir, 'recovery-phrase')), 0o600, 'plain')
  phrase.protect(dir, 'pw')
  t.is(modeOf(path.join(dir, 'recovery-phrase')), 0o600, 'sealed')
})

test('a new instance folder is its owner\'s only', { skip: !posix }, async (t) => {
  const dir = path.join(tmpDir(t), 'app')
  await open(t, { dir, bootstrap: null })
  t.is(modeOf(dir), 0o700)
})

test('a crash while protecting the phrase leaves it readable', (t) => {
  const dir = tmpDir(t)
  phrase.save(dir, WORDS)
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('crash') } // stops between writing the sealed copy and putting it in place
  try {
    t.exception(() => phrase.protect(dir, 'pw'))
  } finally {
    fs.renameSync = rename
  }
  t.is(phrase.open(dir), WORDS, 'the plain phrase is still there')
  phrase.protect(dir, 'pw')
  t.is(phrase.open(dir, 'pw'), WORDS, 'and can be protected afterwards')
})

test('a torn entry in the logs file doesn\'t shift the next ones', (t) => {
  const dir = tmpDir(t)
  const [s, l1, l2] = [1, 2, 3].map((n) => b4a.alloc(32, n))
  instance.addLog(dir, s, l1)
  fs.appendFileSync(path.join(dir, 'logs'), b4a.alloc(40, 9)) // a crash mid-append
  const hex = (b) => b4a.toString(b, 'hex')
  t.alike([...instance.readLogs(dir).get(hex(s))], [hex(l1)], 'the torn entry is ignored')
  instance.addLog(dir, s, l2)
  t.alike([...instance.readLogs(dir).get(hex(s))], [hex(l1), hex(l2)], 'the next entry reads right')
})
