#!/usr/bin/env node
// Spec 025 D3: writes the online hours a device recorded (lib/holding.js
// `hours`, saved as @hg/meta 'seen') to a file the simulator reads
// (run.js --real), every device key replaced by a random label.
//   node research/holders/export.js <engine or hypergraph folder> [--out hours.json]
// Opens the index read only: works with the app or helper running (it saves
// the hours every 5 minutes and on close).
//
// What a map means: `self` is this device's own hours online (its true
// pattern). `seen` is the hours this device was online AND connected to that
// holder (024 counts nothing else), not the holder's own pattern.

const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const HyperDB = require('hyperdb')
const b4a = require('b4a')
const def = require('../../lib/index/spec/hyperdb')
const { unpackHours } = require('../../lib/circles.js')

// seen: the saved row ({ at: { device: ms }, hours: { device: { hour, bits } } }) -> the file's content
function anonymise (seen, random = Math.random) {
  const keys = Object.keys(seen.hours || {})
  const own = keys.filter((k) => !(k in (seen.at || {}))) // holders are in `at` (last seen); this device isn't
  const order = keys.map((k) => [k, random()]).sort((a, b) => a[1] - b[1]).map(([k]) => k) // labels say nothing of the keys' order
  let n = 0
  const devices = order.map((k) => {
    const self = own.length === 1 && own[0] === k
    const hours = [...unpackHours(seen.hours[k])].sort((a, b) => a - b)
    return { label: self ? 'self' : 'holder-' + ++n, role: self ? 'self' : 'seen', online: Math.round(100 * hours.length / 720), hours }
  })
  return { version: 1, exported: Math.floor(Date.now() / 3600000), devices }
}

async function main () {
  const args = process.argv.slice(2)
  const dir = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--out')
  const out = args.includes('--out') ? args[args.indexOf('--out') + 1] : 'hours.json'
  if (!dir || !fs.existsSync(path.join(dir, 'index'))) {
    console.error('usage: node research/holders/export.js <engine folder (has an index/ folder)> [--out hours.json]')
    process.exit(1)
  }
  const db = HyperDB.rocks(path.join(dir, 'index'), def, { readOnly: true })
  try {
    await db.ready()
    const row = await db.get('@hg/meta', { name: 'seen' })
    if (!row) throw new Error('no online hours recorded here: is this device in a circle (hypergraph 024+)?')
    const file = anonymise(JSON.parse(b4a.toString(row.value)), () => crypto.randomInt(2 ** 31) / 2 ** 31)
    fs.writeFileSync(out, JSON.stringify(file))
    for (const d of file.devices) console.log(`${d.label}: ${d.hours.length} hours online in the last 30 days (${d.online} %)${d.role === 'seen' ? ', while this device was online too' : ''}`)
    console.log('written to ' + path.resolve(out))
  } finally {
    await db.close()
  }
}

if (require.main === module) main().catch((err) => { console.error(err.message); process.exit(1) })

module.exports = { anonymise }
