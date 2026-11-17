#!/usr/bin/env node
// Spec 025 D2/D4: runs the simulator and prints markdown tables.
//   node research/holders/run.js                       made-up mixes, sizes 2 5 15 50, with and without a helper
//   node research/holders/run.js --sizes 5,15 --seeds 3 --mix global
//   node research/holders/run.js --repair              RQ2: the 7-day rule and the extra copy, on and off
//   node research/holders/run.js --analytic            RQ1: copies needed, plain copies vs erasure coding
//   node research/holders/run.js --real pc.json vps.json [--fill friends]   D3 files' own maps, topped up to each size from a mix
//   node research/holders/run.js --real vps.json --seen      also the first file's `seen` maps: true patterns only from an always-on device (both online = its holders' own hours)

const fs = require('fs')
const { STRATEGIES, circle, replay, simulate, replication, erasure, copiesFor, HOUR_WEEK } = require('./sim.js')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : args[i + 1] }
const flag = (name) => args.includes('--' + name)
const sizes = opt('sizes', '2,5,15,50').split(',').map(Number)
const seeds = Number(opt('seeds', 5))
const mixes = opt('mix', 'friends,global,phones').split(',')
const strategies = opt('strategies', Object.keys(STRATEGIES).join(',')).split(',')
const pct = (x) => (100 * x).toFixed(1)
const extra = { lazy: { extra: 'lazy' }, none: { extra: false } }[opt('extra', '')] || {} // --extra lazy|none: the extra copy rule for every strategy

function average (make, strategy, simOpts) {
  const runs = []
  for (let seed = 1; seed <= seeds; seed++) runs.push(simulate(make(seed), strategy, { ...simOpts, seed }))
  const out = {}
  for (const k of Object.keys(runs[0]).filter((k) => typeof runs[0][k] === 'number')) out[k] = runs.reduce((a, r) => a + r[k], 0) / runs.length
  return out
}

const HEAD = '| strategy | avail % | worst 10% | fresh % | uploads/wk | moves/wk | copies | max load | helper share |\n|---|---|---|---|---|---|---|---|---|'
const row = (name, r) => `| ${name} | ${pct(r.avail)} | ${pct(r.worst)} | ${pct(r.fresh)} | ${r.uploads.toFixed(2)} | ${r.moves.toFixed(2)} | ${r.copies.toFixed(2)} | ${r.maxLoad.toFixed(1)}x | ${pct(r.helperShare)} |`

function table (title, make, simOpts = {}, names = strategies) {
  console.log(`\n### ${title}\n\n${HEAD}`)
  let err = 0
  for (const s of names) { const r = average(make, s, simOpts); err = r.obsErr; console.log(row(s, r)) }
  console.log(row('(ceiling: everyone holds)', average(make, 'hash', { ...simOpts, copies: 1e9 })))
  console.log(`
024's observed share (both online / owner online) is off from the true share by ${pct(err)} points on average.`)
}

if (flag('analytic')) {
  console.log('### RQ1: copies for a target, each device online p of the time, independent\n')
  console.log('| p | copies for 99 % | copies for 99.9 % | 5 copies | 3-of-10 pieces (3.3x) | 2-of-5 (2.5x) |\n|---|---|---|---|---|---|')
  for (const p of [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 0.95]) {
    console.log(`| ${p} | ${copiesFor(p, 0.99)} | ${copiesFor(p, 0.999)} | ${pct(replication(p, 5))} | ${pct(erasure(p, 3, 10))} | ${pct(erasure(p, 2, 5))} |`)
  }
} else if (flag('repair')) {
  for (const size of sizes) {
    for (const helper of [false, true]) {
      const make = (seed) => circle({ size, mix: mixes[0], helper, seed })
      console.log(`\n### RQ2 repair, ${mixes[0]}, ${size} people${helper ? ' + helper' : ''}\n\n| strategy | rule | avail % | worst 10% | uploads/wk | copies |\n|---|---|---|---|---|---|`)
      for (const s of strategies) {
        for (const [rule, o] of [['024 (7 d, extra)', {}], ['no extra copy', { extra: false }], ['1 day', { staleH: 24 }], ['never replace', { staleH: Infinity }], ['back = counts again', { reintegrate: true }], ['back again + no extra', { reintegrate: true, extra: false }], ['lazy extras (kept)', { extra: 'lazy' }], ['lazy extras, never replace', { extra: 'lazy', staleH: Infinity }]]) {
          const r = average(make, s, o)
          console.log(`| ${s} | ${rule} | ${pct(r.avail)} | ${pct(r.worst)} | ${r.uploads.toFixed(2)} | ${r.copies.toFixed(2)} |`)
        }
      }
    }
  }
} else if (flag('real')) {
  const files = args.slice(args.indexOf('--real') + 1).filter((a) => !a.startsWith('--') && a.endsWith('.json'))
  const own = files.flatMap((f) => { const x = JSON.parse(fs.readFileSync(f, 'utf-8')); return x.devices.filter((d) => d.role === 'self' || (flag('seen') && f === files[0])).map((d) => ({ ...d, label: f + ' ' + d.label, end: x.exported })) })
  for (const d of own) console.log(`- ${d.label}: online ${pct(d.hours.length / 720)} % of its last 30 days`)
  for (const size of sizes.filter((s) => s >= own.length)) {
    for (const helper of [false, true]) {
      const make = (seed) => {
        const c = circle({ size: size - own.length, mix: opt('fill', 'friends'), helper, seed })
        const real = own.map((d) => ({ kind: 'real', tz: 0, joinAt: 0, online: replay(d.hours, c.H, d.end), helper: false }))
        return { ...c, devices: [...real, ...c.devices] }
      }
      table(`real: ${own.length} exported + ${size - own.length} ${opt('fill', 'friends')}${helper ? ' + helper' : ''}`, make)
    }
  }
} else {
  for (const mix of mixes) {
    for (const size of sizes) {
      for (const helper of [false, true]) table(`${mix}, ${size} people${helper ? ' + helper' : ''} (${seeds} seeds, ${8 - 4} weeks measured)`, (seed) => circle({ size, mix, helper, seed }), extra)
    }
  }
}
if (!flag('analytic')) console.log(`\n(${HOUR_WEEK * 8} hours simulated per run, the last half measured.)`)
