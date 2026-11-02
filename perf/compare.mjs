#!/usr/bin/env node
// `npm run perf:compare`: the last perf run against the previous one, per runtime, from
// perf/history.jsonl. The same file in hypergraph, SwarmFS and swarmwire.
//
//   npm run perf:compare                    # last run vs the one before (each runtime)
//   npm run perf:compare -- --sha 1531fb4   # last run vs the last run at that commit
//   npm run perf:compare -- --node          # one runtime (--bare)
//
// A change is flagged only when it is beyond this machine's run-to-run noise (two runs of one
// commit must flag nothing; measured 2026-11-01: half the scenarios move under ~10%, one in ten
// over 20-45%, more than their samples' spread shows):
//   - the median moved over max(25%, 3 × the larger half-range (max - min) / 2 / median),
//   - the minimum moved over 25% the same way (a few slow samples move a median, not a min),
//   - and, for times, by more than 0.5 ms.
// So it catches changes of about 25% and more; a smaller one needs repeated runs to show.
// Scenarios marked flat (their cost must not grow with the size) also show their curve:
// biggest size against smallest, NOT FLAT past 1.5×.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const shaArg = argv.includes('--sha') ? argv[argv.indexOf('--sha') + 1] : null
const runtimes = argv.includes('--node') ? ['node'] : argv.includes('--bare') ? ['bare'] : ['node', 'bare']
const THRESHOLD = 0.25
const SPREADS = 3
const FLOOR_MS = 0.5
const FLAT = 1.5

const file = path.join(here, 'history.jsonl')
const rows = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`

// 'worse', 'better' or null (within noise)
function judge (p, r) {
  const change = (r.median - p.median) / p.median
  const minChange = p.min ? (r.min - p.min) / p.min : change
  const halfRange = (x) => (x.n > 1 && x.median ? (x.max - x.min) / 2 / x.median : 0)
  const bar = Math.max(THRESHOLD, SPREADS * Math.max(halfRange(r), halfRange(p)))
  if (Math.abs(change) <= bar) return null
  if (Math.sign(minChange) !== Math.sign(change) || Math.abs(minChange) <= THRESHOLD) return null
  if (r.unit === 'ms' && Math.abs(r.median - p.median) <= FLOOR_MS) return null
  return (r.better === 'higher' ? change < 0 : change > 0) ? 'worse' : 'better'
}

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
  const b = now[0]
  if (!base) {
    console.log(`${runtime}: ${shaArg ? `no run at ${shaArg}` : 'only one run'} to compare with`)
  } else {
    const before = new Map(mine.filter((r) => r.run === base).map((r) => [r.scenario + '@' + r.size, r]))
    const a = before.values().next().value
    console.log(`${runtime}: ${b.sha.slice(0, 10)}${b.dirty ? '+' : ''} (${b.version}, ${last.slice(0, 16)}) vs ${a.sha.slice(0, 10)}${a.dirty ? '+' : ''} (${a.version}, ${base.slice(0, 16)})`)
    if (JSON.stringify(a.machine) !== JSON.stringify(b.machine)) console.log(`  (another machine: ${a.machine.cpu}, ${a.machine.cores} cores → ${b.machine.cpu}, ${b.machine.cores} cores: compare with care)`)
    for (const r of now) {
      const p = before.get(r.scenario + '@' + r.size)
      const name = `  ${r.scenario.padEnd(24)} ${String(r.size).padStart(7)}`
      if (!p) { console.log(`${name}  ${String(r.median).padStart(9)} ${r.unit}  (new)`); continue }
      const verdict = judge(p, r)
      if (verdict) flagged++
      console.log(`${name}  ${String(p.median).padStart(9)} → ${String(r.median).padStart(9)} ${r.unit.padEnd(10)} ${pct((r.median - p.median) / p.median).padStart(6)}${verdict ? '  ' + verdict.toUpperCase() : ''}`)
    }
    for (const [k, p] of before) if (!now.some((r) => r.scenario + '@' + r.size === k)) console.log(`  ${p.scenario.padEnd(24)} ${String(p.size).padStart(7)}  (gone)`)
  }

  const flat = [...new Set(now.filter((r) => r.flat).map((r) => r.scenario))]
  if (flat.length) console.log(`  curves that must stay flat (biggest size vs smallest):`)
  for (const s of flat) {
    const pts = now.filter((r) => r.scenario === s).sort((x, y) => x.size - y.size)
    const lo = pts[0]
    const hi = pts[pts.length - 1]
    const growth = lo.better === 'higher' ? lo.median / hi.median : hi.median / lo.median
    console.log(`    ${s.padEnd(24)} ${pts.map((x) => `${x.size}: ${x.median}`).join(', ')} ${lo.unit}  ×${growth.toFixed(2)}${growth > FLAT ? '  NOT FLAT' : ''}`)
  }
}
if (!rows.length) console.log('no history yet: npm run perf')
console.log(flagged ? `\n${flagged} change(s) beyond the noise` : '\nno change beyond the noise')
