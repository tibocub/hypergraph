#!/usr/bin/env node
// `npm run perf:compare`: the last perf run against the previous one, per runtime, from
// perf/history.jsonl. The same file in hypergraph, SwarmFS and swarmwire.
//
//   npm run perf:compare                    # last run vs the one before (each runtime)
//   npm run perf:compare -- --sha 1531fb4   # last run vs the last run at that commit
//   npm run perf:compare -- --node          # one runtime (--bare)
//
// A change is flagged when it is over 15% plus the larger of the two spreads.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const shaArg = argv.includes('--sha') ? argv[argv.indexOf('--sha') + 1] : null
const runtimes = argv.includes('--node') ? ['node'] : argv.includes('--bare') ? ['bare'] : ['node', 'bare']
const THRESHOLD = 0.15

const file = path.join(here, 'history.jsonl')
const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []

let flagged = 0
for (const runtime of runtimes) {
  const mine = rows.filter((r) => r.runtime === runtime)
  const runs = [...new Set(mine.map((r) => r.run))].sort()
  if (!runs.length) continue
  const last = runs[runs.length - 1]
  const base = shaArg
    ? runs.filter((r) => r !== last && mine.some((x) => x.run === r && x.sha.startsWith(shaArg))).pop()
    : runs[runs.length - 2]
  const now = mine.filter((r) => r.run === last)
  if (!base) {
    console.log(`${runtime}: ${shaArg ? `no run at ${shaArg}` : 'only one run'} to compare with`)
    continue
  }
  const before = new Map(mine.filter((r) => r.run === base).map((r) => [r.scenario + '@' + r.size, r]))
  const a = before.values().next().value
  const b = now[0]
  console.log(`${runtime}: ${b.sha.slice(0, 10)}${b.dirty ? '+' : ''} (${b.version}, ${last.slice(0, 16)}) vs ${a.sha.slice(0, 10)}${a.dirty ? '+' : ''} (${a.version}, ${base.slice(0, 16)})`)
  if (JSON.stringify(a.machine) !== JSON.stringify(b.machine)) console.log(`  (another machine: ${a.machine.cpu}, ${a.machine.cores} cores → ${b.machine.cpu}, ${b.machine.cores} cores: compare with care)`)
  for (const r of now) {
    const p = before.get(r.scenario + '@' + r.size)
    const name = `  ${r.scenario.padEnd(22)} ${String(r.size).padStart(7)}`
    if (!p) { console.log(`${name}  ${String(r.median).padStart(9)} ${r.unit}  (new)`); continue }
    const change = (r.median - p.median) / p.median
    const worse = r.better === 'higher' ? change < 0 : change > 0
    const beyond = Math.abs(change) > THRESHOLD + Math.max(r.spread, p.spread)
    if (beyond) flagged++
    const pct = `${change >= 0 ? '+' : ''}${(change * 100).toFixed(0)}%`
    console.log(`${name}  ${String(p.median).padStart(9)} → ${String(r.median).padStart(9)} ${r.unit.padEnd(10)} ${pct.padStart(6)}${beyond ? (worse ? '  WORSE' : '  better') : ''}`)
  }
  for (const [k, p] of before) if (!now.some((r) => r.scenario + '@' + r.size === k)) console.log(`  ${p.scenario.padEnd(22)} ${String(p.size).padStart(7)}  (gone)`)
}
if (!rows.length) console.log('no history yet: npm run perf')
if (flagged) console.log(`\n${flagged} change(s) beyond ${THRESHOLD * 100}% + spread`)
