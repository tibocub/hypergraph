#!/usr/bin/env node
// Runs one test file and prefixes each output line with the seconds elapsed,
// to see where a slow test spends its time.
//
//   node scripts/test-timeline.js <file> [regex]
//
// With a regex, only matching lines are printed (results are always shown).

const { spawn } = require('child_process')
const path = require('path')

const [file, pattern] = process.argv.slice(2)
if (!file) {
  console.error('usage: node scripts/test-timeline.js <file> [regex]')
  process.exit(1)
}
const filter = pattern ? new RegExp(pattern) : null
const brittle = path.join(__dirname, '..', 'node_modules', 'brittle', 'bin', 'node.js')
const start = Date.now()
const p = spawn(process.execPath, [brittle, file], { cwd: path.join(__dirname, '..') })
let buf = ''
const onData = (d) => {
  buf += d
  let i
  while ((i = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, i)
    buf = buf.slice(i + 1)
    if (!line.trim()) continue
    if (filter && !filter.test(line) && !/^(not )?ok \d|# tests|# asserts/.test(line)) continue
    process.stdout.write(`${((Date.now() - start) / 1000).toFixed(1).padStart(6)}s  ${line}\n`)
  }
}
p.stdout.on('data', onData)
p.stderr.on('data', onData)
p.on('exit', (code) => process.exit(code))
