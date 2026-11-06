#!/usr/bin/env node
// The soak run: a few scripted forum members (soak/member.js, one process
// each) on the public DHT for hours, posting, going offline and back, each
// keeping a delivery log; then everyone online for a settle period, a final
// snapshot, and the report (soak/report.js). See soak/README.md.
//
//   npm run soak -- [--members 4] [--hours 2] [--local] [--gap 20,60] [--offline 30,600]
//                   [--offline-chance 0.08] [--settle 300] [--dir <base>]
//   npm run soak -- --report <run dir>

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { report } = require('./report.js')

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// The dev machine's C: is nearly full: runs go to E:\Code\P2P\.tmp when it exists.
const BASE = process.env.SOAK_DIR || (fs.existsSync('E:/Code/P2P/.tmp') ? 'E:/Code/P2P/.tmp' : os.tmpdir())

function parseArgs (argv) {
  const o = { members: 4, hours: 2, local: false, gap: [20, 60], offline: [30, 600], offlineChance: 0.08, settle: 300, dir: BASE, report: null }
  const pair = (s) => s.split(',').map(Number)
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--members') o.members = Number(argv[++i])
    else if (a === '--hours') o.hours = Number(argv[++i])
    else if (a === '--local') o.local = true
    else if (a === '--gap') o.gap = pair(argv[++i])
    else if (a === '--offline') o.offline = pair(argv[++i])
    else if (a === '--offline-chance') o.offlineChance = Number(argv[++i])
    else if (a === '--settle') o.settle = Number(argv[++i])
    else if (a === '--dir') o.dir = argv[++i]
    else if (a === '--report') o.report = argv[++i]
    else throw new Error('unknown option ' + a)
  }
  // Low load is a hard rule (the PC rebooted once under an all-cores run).
  if (o.members < 2 || o.members > 6) throw new Error('--members: 2 to 6')
  if (o.gap[0] < 1) throw new Error('--gap: at least 1 s between actions')
  return o
}

async function main () {
  const o = parseArgs(process.argv.slice(2))
  if (o.report) return report(o.report).ok

  const runDir = path.join(o.dir, `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`)
  fs.mkdirSync(runDir, { recursive: true })
  let testnet = null
  let bootstrap = null
  if (o.local) {
    testnet = await require('hyperdht/testnet')(3)
    bootstrap = testnet.bootstrap
  }
  fs.writeFileSync(path.join(runDir, 'config.json'), JSON.stringify({ ...o, bootstrap }, null, 2))
  const say = (msg) => console.log(`[soak ${new Date().toISOString().slice(11, 19)}] ${msg}`)
  say(`${o.members} members, ${o.hours} h + ${o.settle} s settle, ${o.local ? 'local DHT' : 'public DHT'}, in ${runDir}`)

  let phase = 'run' // 'run' -> 'settle' -> 'stop'
  const members = []
  const crash = (i, code) => fs.appendFileSync(path.join(runDir, `m${i}.jsonl`), JSON.stringify({ ev: 'crash', code, at: Date.now() }) + '\n')
  const start = (i) => {
    const m = members[i] || (members[i] = { i })
    m.waking = null
    const err = fs.openSync(path.join(runDir, `m${i}.err`), 'a')
    const p = spawn(process.execPath, [path.join(__dirname, 'member.js'), runDir, String(i)], { stdio: ['ignore', 'pipe', err] })
    try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL) } catch { /* not allowed here */ } // keep the machine responsive
    let out = ''
    p.stdout.on('data', (d) => { out += d })
    m.exit = new Promise((resolve) => p.on('exit', (code) => {
      fs.closeSync(err)
      m.proc = null
      if (phase === 'stop') {
        if (code !== 0) { say(`m${i} exited with code ${code} while stopping (see m${i}.err)`); crash(i, code) }
        return resolve()
      }
      const offline = /SOAK-OFFLINE (\d+)/.exec(out)
      if (code === 75 && offline) {
        const ms = phase === 'run' ? Number(offline[1]) : 0
        m.waking = setTimeout(() => start(i), ms)
      } else {
        say(`m${i} exited with code ${code} (see m${i}.err); restarting in 10 s`)
        crash(i, code)
        m.waking = setTimeout(() => start(i), 10000)
      }
      resolve()
    }))
    m.proc = p
  }
  for (let i = 0; i < o.members; i++) start(i)

  const runMs = o.hours * 3600e3
  const began = Date.now()
  while (Date.now() - began < runMs) {
    await sleep(Math.min(60000, runMs - (Date.now() - began)))
    say(`${Math.round((Date.now() - began) / 60000)} min, online: ${members.filter((m) => m.proc).map((m) => 'm' + m.i).join(' ') || 'none'}`)
  }

  phase = 'settle'
  fs.writeFileSync(path.join(runDir, 'settle'), '')
  for (const m of members) if (m.waking) { clearTimeout(m.waking); start(m.i) }
  say(`settling ${o.settle} s, everyone online`)
  await sleep(o.settle * 1000)

  // A member that crashed during the settle may be waiting to restart: let it come back first.
  for (const m of members) if (m.waking) { clearTimeout(m.waking); start(m.i) }
  phase = 'stop'
  fs.writeFileSync(path.join(runDir, 'stop'), '')
  say('stopping: final snapshots')
  for (const m of members) {
    let timer = null
    const late = new Promise((resolve) => { timer = setTimeout(() => resolve('late'), 120000) })
    if (m.proc && await Promise.race([m.exit, late]) === 'late') { say(`m${m.i} did not stop within 120 s: killed`); m.proc.kill() }
    clearTimeout(timer)
  }
  if (testnet) await testnet.destroy()
  return report(runDir).ok
}

main().then((ok) => process.exit(ok ? 0 : 1), (err) => { console.error(err); process.exit(2) })
