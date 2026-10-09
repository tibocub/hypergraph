// What the local index can't be rebuilt from (FR-012, research.md A10), kept
// beside it in the instance folder, so a lost or unreadable index is rebuilt
// from the held logs:
//
//   instance.json  the identity's proof, the personal space's keys, the spaces
//                  held and their storage namespaces, the declared types,
//                  budgets (rewritten whole, atomically, when they change)
//   logs           every device log accepted in a space: 32 B space key +
//                  32 B log key per entry, appended (once per log)

const fs = require('fs')
const path = require('path')
const b4a = require('b4a')

const FILE = 'instance.json'
const LOGS = 'logs'
const ENTRY = 64

function read (dir) {
  let text = null
  try { text = fs.readFileSync(path.join(dir, FILE), 'utf-8') } catch { return null }
  try { return JSON.parse(text) } catch { return null }
}

function write (dir, value) {
  const file = path.join(dir, FILE)
  fs.writeFileSync(file + '.tmp', JSON.stringify(value))
  fs.renameSync(file + '.tmp', file)
}

// The logs named so far: Map space hex -> Set of log hex.
function readLogs (dir) {
  const out = new Map()
  let bytes = null
  try { bytes = fs.readFileSync(path.join(dir, LOGS)) } catch { return out }
  for (let i = 0; i + ENTRY <= bytes.byteLength; i += ENTRY) { // a torn last entry is ignored
    const space = b4a.toString(bytes.subarray(i, i + 32), 'hex')
    if (!out.has(space)) out.set(space, new Set())
    out.get(space).add(b4a.toString(bytes.subarray(i + 32, i + ENTRY), 'hex'))
  }
  return out
}

function addLog (dir, space, log) {
  fs.appendFileSync(path.join(dir, LOGS), b4a.concat([space, log]))
}

// Moves an unreadable folder aside (index.broken-<time>): kept for whoever
// wants to look at it, never deleted by hypergraph.
function setAside (dir) {
  fs.renameSync(dir, dir + '.broken-' + Date.now())
}

module.exports = { read, write, readLogs, addLog, setAside }
