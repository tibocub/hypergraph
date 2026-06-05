const { spawn } = require('child_process')
const path = require('path')
const os = require('os')
const fs = require('fs')
const Corestore = require('corestore')
const { Hypergraph } = require('../../index.js')
const ForumStorage = require('./storage')
const ForumPolicy = require('./policy')

function mkdtemp (prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function spawnNode (args, opts = {}) {
  const child = spawn(process.execPath, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    ...opts
  })

  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')

  return child
}

function watchLines (child, onLine) {
  let buf = ''
  const onData = (data) => {
    buf += data
    for (;;) {
      const idx = buf.indexOf('\n')
      if (idx === -1) break
      const line = buf.slice(0, idx).replace(/\r$/, '')
      buf = buf.slice(idx + 1)
      if (line.length) onLine(line)
    }
  }

  child.stdout.on('data', onData)
  child.stderr.on('data', onData)
}

async function waitFor (predicate, timeoutMs, pollMs = 50) {
  const start = Date.now()
  for (;;) {
    if (predicate()) return
    if (Date.now() - start > timeoutMs) throw new Error('Timeout waiting for condition')
    await sleep(pollMs)
  }
}

async function main () {
  const root = path.join(__dirname, '..', '..')
  const runDir = mkdtemp('hypergraph-forum-')
  const ownerDir = path.join(runDir, 'owner')
  const peer1Dir = path.join(runDir, 'peer-1')
  const peer2Dir = path.join(runDir, 'peer-2')
  fs.mkdirSync(ownerDir, { recursive: true })
  fs.mkdirSync(peer1Dir, { recursive: true })
  fs.mkdirSync(peer2Dir, { recursive: true })

  const manifestPath = path.join(runDir, 'site.json')

  const spawnOwner = (extraArgs = []) => {
    return spawnNode([
      path.join(root, 'examples', 'forum', 'owner.js'),
      `--storage=${ownerDir}`,
      `--manifest=${manifestPath}`,
      ...extraArgs
    ], { cwd: root })
  }

  let owner = spawnOwner(['--new'])

  let gotSeedPost = false
  let seedPostId = null

  let peer1Granted = false
  let peer1Replied = false
  let peer1SawPost = false

  let peer2Granted = false
  let peer2Replied = false
  let peer2Moderated = false
  let peer2SawPost = false

  let ownerRestarted = false

  const lines = []
  const pushLine = (src, line) => {
    lines.push(`[${src}] ${line}`)
    process.stdout.write(`[${src}] ${line}${os.EOL}`)
  }

  watchLines(owner, (line) => {
    pushLine('owner', line)
    if (line.includes('Seed post:')) {
      gotSeedPost = true
      const parts = line.split('Seed post:')
      if (parts[1]) seedPostId = parts[1].trim()
    }
    if (line.includes('Loaded manifest:') && !ownerRestarted) ownerRestarted = true
  })

  await waitFor(() => fs.existsSync(manifestPath), 10_000)
  await waitFor(() => gotSeedPost && seedPostId, 30_000)

  const peer1 = spawnNode([
    path.join(root, 'examples', 'forum', 'peer.js'),
    `--storage=${peer1Dir}`,
    `--manifest=${manifestPath}`,
    `--replyTo=${seedPostId}`,
    '--replyBody=peer1'
  ], { cwd: root })

  watchLines(peer1, (line) => {
    pushLine('peer1', line)
    if (line.includes('Owner granted writer access')) peer1Granted = true
    if (line.includes('Replied with:')) peer1Replied = true
    if (line.includes('- post/')) peer1SawPost = true
  })

  // Late joiner: start peer2 after peer1 has written.
  await waitFor(() => peer1Replied, 90_000)

  const peer2 = spawnNode([
    path.join(root, 'examples', 'forum', 'peer.js'),
    `--storage=${peer2Dir}`,
    `--manifest=${manifestPath}`,
    '--replyBody=peer2',
    `--moderate=${seedPostId}`,
    '--action=content.hide'
  ], { cwd: root })

  watchLines(peer2, (line) => {
    pushLine('peer2', line)
    if (line.includes('Owner granted writer access')) peer2Granted = true
    if (line.includes('Replied with:')) peer2Replied = true
    if (line.includes('Moderation event:')) peer2Moderated = true
    if (line.includes('- post/')) peer2SawPost = true
  })

  const exitInfo = { owner: null, peer1: null, peer2: null, owner2: null }
  owner.on('exit', (code, signal) => { exitInfo.owner = { code, signal } })
  peer1.on('exit', (code, signal) => { exitInfo.peer1 = { code, signal } })
  peer2.on('exit', (code, signal) => { exitInfo.peer2 = { code, signal } })

  try {
    await waitFor(() => peer1SawPost, 60_000)
    await waitFor(() => peer1Granted || peer1Replied, 60_000)
    await waitFor(() => peer1Replied, 60_000)

    await waitFor(() => peer2SawPost, 60_000)
    await waitFor(() => peer2Granted || peer2Replied || peer2Moderated, 60_000)
    await waitFor(() => peer2Replied, 60_000)
    await waitFor(() => peer2Moderated, 60_000)

    // Give replication some time to converge before shutdown/offline verification.
    await sleep(5_000)

    // Restart owner to ensure manifest reuse works.
    owner.kill()
    await sleep(500)
    owner = spawnOwner([])
    watchLines(owner, (line) => {
      pushLine('owner2', line)
      if (line.includes('Loaded manifest:')) ownerRestarted = true
    })
    owner.on('exit', (code, signal) => { exitInfo.owner2 = { code, signal } })

    await waitFor(() => ownerRestarted, 20_000)

    process.stdout.write(`Forum test passed. Data dir: ${runDir}${os.EOL}`)
    process.exitCode = 0
  } catch (err) {
    process.stderr.write(`Forum test failed: ${err && err.message ? err.message : String(err)}${os.EOL}`)
    process.stderr.write(`Run dir: ${runDir}${os.EOL}`)
    process.exitCode = 1
  } finally {
    try { peer1.kill() } catch {}
    try { peer2.kill() } catch {}
    try { owner.kill() } catch {}

    await sleep(250)

    if (exitInfo.peer1 == null) {
      try { peer1.kill('SIGKILL') } catch {}
    }
    if (exitInfo.peer2 == null) {
      try { peer2.kill('SIGKILL') } catch {}
    }
    if (exitInfo.owner == null) {
      try { owner.kill('SIGKILL') } catch {}
    }

    // Offline verification (avoid RocksDB locking while processes are running)
    if (process.exitCode === 0) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        const store = new Corestore(peer2Dir)
        const graph = new Hypergraph(store)
        await graph.ready()
        await graph.openUserCore(manifest.owner)
        if (manifest.roleBase) await graph.openRoleBase(manifest.roleBase)
        await graph.openContext(manifest.contexts.comments)
        await graph.openContext(manifest.contexts.moderation)

        const storage = new ForumStorage(graph, {
          commentsContext: manifest.contexts.comments,
          moderationContext: manifest.contexts.moderation
        })

        await graph.update()

        const replyEdges = []
        for await (const e of graph.edges(seedPostId, { direction: 'in', type: 'reply' })) replyEdges.push(e)
        if (replyEdges.length < 2) throw new Error(`Expected >= 2 reply edges, got ${replyEdges.length}`)

        const moderation = await storage.getModeration(seedPostId)
        if (moderation.length < 1) throw new Error(`Expected >= 1 moderation event, got ${moderation.length}`)

        const trusted = moderation[0].author
        const policy = new ForumPolicy({ trustedModeratorKeys: [trusted] })
        if (policy.shouldShow(moderation) !== false) throw new Error('Expected policy to hide content based on trusted moderation')

        await graph.close()
        await store.close()
      } catch (err) {
        process.stderr.write(`Forum test failed (offline verify): ${err && err.message ? err.message : String(err)}${os.EOL}`)
        process.exitCode = 1
      }
    }

    if (process.exitCode !== 0) {
      const tail = lines.slice(-80).join(os.EOL)
      process.stderr.write(`--- output (tail) ---${os.EOL}${tail}${os.EOL}`)
    }
  }
}

main().catch((err) => {
  process.stderr.write((err && err.stack) ? err.stack + os.EOL : String(err) + os.EOL)
  process.exitCode = 1
})
