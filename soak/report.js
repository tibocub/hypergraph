// The soak run's report: reads every member's delivery log (m<i>.jsonl in the
// run folder) and says, per member and in total, what was written, what never
// arrived, how long delivery took, offline periods and warnings.
//
//   node soak/report.js <run dir>     (also: npm run soak -- --report <run dir>)
//
// Exit code 1 if a record is lost, a final edit or delete didn't arrive, or a
// member has no final snapshot.

const fs = require('fs')
const path = require('path')

// Nearest-rank percentile of sorted numbers (null if none).
function pct (sorted, q) {
  if (!sorted.length) return null
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]
}

function delays (list) {
  const s = [...list].sort((a, b) => a - b)
  return { n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), max: s.length ? s[s.length - 1] : null }
}

// `logs`: { member name: [events] } in each log's order. Events:
//   { ev: 'put', id, type, at, v }   a record this member wrote (at: before the write; v: its text or vote value)
//   { ev: 'edit', id, at, v }        this member edited its record to v
//   { ev: 'delete', id, at }         this member deleted its record
//   { ev: 'seen', id, at }           a record arrived or changed here
//   { ev: 'offline' | 'online' | 'warning' | 'error' | 'crash', ... }
//   { ev: 'held', at, records: [{ id, type, v }] }   what it holds at the end
function analyze (logs) {
  const records = new Map()
  for (const [name, events] of Object.entries(logs)) {
    for (const e of events) {
      if (e.ev === 'put') records.set(e.id, { id: e.id, type: e.type, author: name, at: e.at, v: e.v, deleted: false })
      else if (e.ev === 'edit' && records.has(e.id)) records.get(e.id).v = e.v
      else if (e.ev === 'delete' && records.has(e.id)) records.get(e.id).deleted = true
    }
  }
  const all = [...records.values()]
  const members = {}
  const allDelays = []
  for (const [name, events] of Object.entries(logs)) {
    const final = events.filter((e) => e.ev === 'held').pop()
    const held = new Map(final ? final.records.map((r) => [r.id, r.v]) : [])
    const seen = new Map()
    for (const e of events) if (e.ev === 'seen' && !seen.has(e.id)) seen.set(e.id, e.at)
    const lost = final ? all.filter((r) => !r.deleted && !held.has(r.id)).map((r) => r.id) : []
    // an edit or a delete that didn't arrive: the old text, or a deleted record still here
    const stale = final ? all.filter((r) => held.has(r.id) && (r.deleted || held.get(r.id) !== r.v)).map((r) => r.id) : []
    const mine = []
    let early = 0 // seen before its author started writing it: one clock on one machine, so a bug
    for (const r of all) {
      if (r.author === name || !seen.has(r.id)) continue
      const d = seen.get(r.id) - r.at
      if (d < 0) early++
      else mine.push(d)
    }
    const warnings = [...new Set(events.filter((e) => e.ev === 'warning').map((e) => e.code))]
    if (early) warnings.push(`SEEN_BEFORE_WRITTEN(${early})`)
    allDelays.push(...mine)
    members[name] = {
      written: all.filter((r) => r.author === name).length,
      final: !!final,
      lost,
      stale,
      delay: delays(mine),
      offline: events.filter((e) => e.ev === 'offline').length,
      crashes: events.filter((e) => e.ev === 'crash').length,
      errors: events.filter((e) => e.ev === 'error').length,
      early,
      warnings
    }
  }
  const list = Object.values(members)
  const total = {
    written: all.length,
    lost: list.reduce((n, m) => n + m.lost.length, 0),
    stale: list.reduce((n, m) => n + m.stale.length, 0),
    delay: delays(allDelays),
    offline: list.reduce((n, m) => n + m.offline, 0),
    crashes: list.reduce((n, m) => n + m.crashes, 0),
    errors: list.reduce((n, m) => n + m.errors, 0),
    early: list.reduce((n, m) => n + m.early, 0),
    missingFinal: Object.keys(members).filter((n) => !members[n].final)
  }
  return { members, total, ok: total.lost === 0 && total.stale === 0 && total.missingFinal.length === 0 }
}

function readRun (dir) {
  const logs = {}
  for (const f of fs.readdirSync(dir).filter((f) => /^m\d+\.jsonl$/.test(f)).sort()) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf-8').split('\n').filter(Boolean)
    const events = []
    for (const l of lines) { try { events.push(JSON.parse(l)) } catch { /* a line cut by a crash */ } }
    logs[f.replace('.jsonl', '')] = events
  }
  return logs
}

const sec = (ms) => (ms === null ? '-' : (ms / 1000).toFixed(ms < 10000 ? 2 : 1) + 's')

function format ({ members, total, ok }) {
  const row = (name, m, lost, stale, warnings) => [name.padEnd(6), String(m.written).padStart(7), String(lost).padStart(5), String(stale).padStart(6),
    sec(m.delay.p50).padStart(7), sec(m.delay.p95).padStart(7), sec(m.delay.max).padStart(8), String(m.offline).padStart(8), String(m.crashes).padStart(7), String(m.errors).padStart(6), '  ' + warnings].join(' ')
  const out = ['member written  lost  stale     p50     p95      max  offline crashes errors  warnings']
  for (const [name, m] of Object.entries(members)) out.push(row(name, m, m.lost.length, m.stale.length, m.warnings.join(',') || '-') + (m.final ? '' : '  (NO FINAL SNAPSHOT)'))
  out.push(row('total', total, total.lost, total.stale, ''))
  out.push(`delays: ${total.delay.n} deliveries (seen - written, records of others)`)
  for (const [name, m] of Object.entries(members)) {
    if (m.lost.length) out.push(`${name} never got: ${m.lost.slice(0, 10).join(' ')}${m.lost.length > 10 ? ' ...' : ''}`)
    if (m.stale.length) out.push(`${name} has an old version of: ${m.stale.slice(0, 10).join(' ')}${m.stale.length > 10 ? ' ...' : ''}`)
  }
  out.push(ok ? 'OK: nothing lost' : 'FAIL: records lost or stale, or a member without a final snapshot')
  return out.join('\n')
}

function report (dir) {
  const result = analyze(readRun(dir))
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(result, null, 2))
  console.log(format(result))
  return result
}

module.exports = { analyze, readRun, format, report }

if (require.main === module) {
  if (!process.argv[2]) { console.error('usage: node soak/report.js <run dir>'); process.exit(2) }
  process.exitCode = report(process.argv[2]).ok ? 0 : 1
}
