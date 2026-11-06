// The soak run's self-check (npm run soak:check, ~2 min; too slow for the
// suite): 3 members on a local DHT for 1 minute with fast timers, then the
// report must find nothing lost.

const test = require('brittle')
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

test('soak run on a local DHT: nothing lost', { timeout: 300000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(process.env.SOAK_DIR || (fs.existsSync('E:/Code/P2P/.tmp') ? 'E:/Code/P2P/.tmp' : os.tmpdir()), 'soak-check-'))
  t.teardown(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10 }))
  const args = ['--local', '--members', '3', '--hours', String(1 / 60), '--gap', '2,4', '--offline', '5,15', '--offline-chance', '0.15', '--settle', '30', '--dir', base]
  const p = spawn(process.execPath, [path.join(__dirname, 'run.js'), ...args], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d; process.stdout.write('# ' + String(d).replace(/\n(?=.)/g, '\n# ')) })
  const code = await new Promise((resolve) => p.on('exit', resolve))
  const run = fs.readdirSync(base).find((d) => d.startsWith('soak-'))
  const { total, ok } = JSON.parse(fs.readFileSync(path.join(base, run, 'report.json'), 'utf-8'))
  t.is(code, 0, 'run.js exits 0')
  t.ok(ok, 'report ok')
  t.is(total.lost, 0, 'nothing lost')
  t.is(total.stale, 0, 'every edit and delete arrived')
  t.ok(total.written >= 10, `records written (${total.written})`)
  t.ok(total.delay.n > 0, 'deliveries measured')
  t.is(total.early, 0, 'nothing seen before it was written')
  t.ok(total.offline > 0, 'members went offline and back')
  t.ok(out.includes('OK: nothing lost'))
})
