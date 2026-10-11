// Starts a writer process (bench/next/_writer.js) and talks to it:
//   const w = writerProcess()
//   await w.call('open', { dir, bootstrap, count: 10 })
//   ...
//   await w.close()

const { spawn } = require('child_process')
const path = require('path')
const readline = require('readline')

function writerProcess () {
  const child = spawn(process.execPath, [path.join(__dirname, '_writer.js')], { stdio: ['pipe', 'pipe', 'inherit'] })
  const waiting = new Map()
  let next = 0
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    let msg = null
    try { msg = JSON.parse(line) } catch { return console.log('  [writer]', line) }
    const w = waiting.get(msg.id)
    if (!w) return
    waiting.delete(msg.id)
    if (msg.error) w.reject(new Error(msg.error))
    else w.resolve(msg)
  })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  child.on('exit', () => {
    for (const w of waiting.values()) w.reject(new Error('the writer process exited'))
    waiting.clear()
  })
  return {
    call (cmd, args = {}) {
      const id = next++
      return new Promise((resolve, reject) => {
        waiting.set(id, { resolve, reject })
        child.stdin.write(JSON.stringify({ id, cmd, ...args }) + '\n')
      })
    },
    async close () {
      if (child.exitCode !== null) return
      child.stdin.end()
      const timer = setTimeout(() => child.kill(), 15000)
      await exited
      clearTimeout(timer)
    }
  }
}

module.exports = { writerProcess }
