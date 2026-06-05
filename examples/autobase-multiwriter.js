const Corestore = require('corestore')
const Autobase = require('autobase')
const os = require('os')
const path = require('path')
const fs = require('fs')

function argValue (argv, key) {
  const pref = `--${key}=`
  const a = argv.find(v => v.startsWith(pref))
  return a ? a.slice(pref.length) : null
}

async function replicate (storeA, storeB) {
  const s1 = storeA.replicate(true, { live: true })
  const s2 = storeB.replicate(false, { live: true })
  s1.pipe(s2).pipe(s1)
  return { s1, s2 }
}

async function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main () {
  const argv = process.argv.slice(2)
  const keep = argv.includes('--keep')

  const dirA = argValue(argv, 'a') || path.join(os.tmpdir(), `autobase-multiwriter-a-${process.pid}-${Date.now()}`)
  const dirB = argValue(argv, 'b') || path.join(os.tmpdir(), `autobase-multiwriter-b-${process.pid}-${Date.now()}`)

  fs.mkdirSync(dirA, { recursive: true })
  fs.mkdirSync(dirB, { recursive: true })

  const storeA = new Corestore(dirA)
  const storeB = new Corestore(dirB)

  // Base A: creates a new Autobase
  const baseA = new Autobase(storeA, null, { open, apply, valueEncoding: 'json' })
  await baseA.ready()

  // Base B: joins A's Autobase key
  const baseB = new Autobase(storeB, baseA.key, { open, apply, valueEncoding: 'json' })
  await baseB.ready()

  console.log('Store A:', dirA)
  console.log('Store B:', dirB)
  console.log('Autobase key:', baseA.key.toString('hex'))
  console.log('Writer A key:', baseA.local.key.toString('hex'))
  console.log('Writer B key:', baseB.local.key.toString('hex'))

  const { s1, s2 } = await replicate(storeA, storeB)

  // A must explicitly add B as a writer (facts-in-log)
  await baseA.append({ addWriter: baseB.local.key.toString('hex') })
  await baseA.update()

  // B updates to observe the addWriter event (host.addWriter in apply)
  await baseB.update()

  // Now both can append their own entries
  await baseA.append({ msg: 'hello from A' })
  await baseB.append({ msg: 'hello from B' })

  // Let replication catch up
  for (let i = 0; i < 50; i++) {
    await baseA.update()
    await baseB.update()

    if (baseA.view.length >= 3 && baseB.view.length >= 3) break
    await sleep(50)
  }

  console.log('\nMerged view (A):')
  for (let i = 0; i < baseA.view.length; i++) {
    console.log(i, await baseA.view.get(i))
  }

  console.log('\nMerged view (B):')
  for (let i = 0; i < baseB.view.length; i++) {
    console.log(i, await baseB.view.get(i))
  }

  await s1.destroy()
  await s2.destroy()
  await baseA.close()
  await baseB.close()
  await storeA.close()
  await storeB.close()

  if (!keep) {
    try { fs.rmSync(dirA, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(dirB, { recursive: true, force: true }) } catch {}
  }
}

function open (store) {
  return store.get({ name: 'view', valueEncoding: 'json' })
}

async function apply (nodes, view, host) {
  for (const { value } of nodes) {
    if (value && value.addWriter) {
      await host.addWriter(Buffer.from(value.addWriter, 'hex'), { indexer: true })
      continue
    }

    await view.append(value)
  }
}

main().catch(console.error)
