function nowMs () {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') return performance.now()
  return Date.now()
}

async function collectAsync (iter, limit = Infinity) {
  const out = []
  let i = 0
  for await (const item of iter) {
    if (i++ >= limit) break
    out.push(item)
  }
  return out
}

function edgeKey (e) {
  return `${e && e.from ? e.from : ''}|${e && e.to ? e.to : ''}|${e && e.type ? e.type : ''}|${e && e.context ? e.context : ''}`
}

function tagNodeId (tag) {
  return `tag:${tag}`
}

module.exports = async function runQueryV0 (graph, body) {
  const t0 = nowMs()

  if (!body || typeof body !== 'object') throw new Error('query body is required')
  const scope = body.scope || null
  if (!scope || !Array.isArray(scope.contexts)) throw new Error('scope.contexts must be an array')

  const query = body.query || null
  if (!query || typeof query !== 'object') throw new Error('query is required')

  // Ensure requested contexts are opened. Scope is explicit, but GraphView still scans opened contexts.
  // v0 keeps it simple by opening exactly what the user asked for.
  const openedContexts = []
  for (const keyHex of scope.contexts) {
    if (typeof keyHex !== 'string' || keyHex.length === 0) continue
    await graph.openContext(keyHex, { writeMode: query.writeMode })
    openedContexts.push(keyHex)
  }

  const nodes = []
  const edges = []

  if (query.type === 'all') {
    const limit = typeof query.limit === 'number' ? query.limit : 500
    const includeEdges = query.includeEdges !== false
    const edgeLimit = typeof query.edgeLimit === 'number' ? query.edgeLimit : 200
    const includeTags = query.includeTags !== false
    const tagLimit = typeof query.tagLimit === 'number' ? query.tagLimit : 500
    const tagNodeLimit = typeof query.tagNodeLimit === 'number' ? query.tagNodeLimit : 200

    const q = graph.query().limit(limit)
    nodes.push(...(await collectAsync(q, limit)))

    if (includeEdges) {
      const seen = new Set()
      for (const n of nodes) {
        for (const direction of ['out', 'in']) {
          const it = graph.edges(n.id, { direction, limit: edgeLimit })
          for await (const e of it) {
            const k = edgeKey(e)
            if (seen.has(k)) continue
            seen.add(k)
            edges.push(e)
          }
        }
      }
    }

    if (includeTags) {
      // Tags are not edges in the underlying graph view, so we model them as:
      // node: { id: 'tag:<tag>', type: 'tag' }
      // edge: { from: <entityId>, to: 'tag:<tag>', type: 'tagged' }

      const tagNodes = new Map()
      const edgeSeen = new Set(edges.map(edgeKey))

      const contexts = Array.isArray(scope.contexts) ? scope.contexts : []
      let scanned = 0

      for (const keyHex of contexts) {
        if (typeof keyHex !== 'string' || keyHex.length === 0) continue
        const ctx = await graph.openContext(keyHex)
        if (!ctx || !ctx.view) continue

        const stream = ctx.view.createReadStream({ gte: 't:', lt: 't:\uffff', limit: tagLimit })
        for await (const entry of stream) {
          const v = entry && entry.value ? entry.value : null
          if (!v || !v.tag || !v.entityId) continue

          const tid = tagNodeId(v.tag)
          if (!tagNodes.has(tid) && tagNodes.size < tagNodeLimit) {
            tagNodes.set(tid, { id: tid, type: 'tag', tag: v.tag })
          }

          const e = { from: v.entityId, to: tid, type: 'tagged', author: v.author, createdAt: v.createdAt, context: keyHex }
          const k = edgeKey(e)
          if (!edgeSeen.has(k)) {
            edgeSeen.add(k)
            edges.push(e)
          }

          scanned++
          if (scanned >= tagLimit) break
        }
      }

      for (const tn of tagNodes.values()) nodes.push(tn)
    }
  } else if (query.type === 'nodeByType') {
    const limit = typeof query.limit === 'number' ? query.limit : 100
    const nodeType = query.nodeType
    if (typeof nodeType !== 'string' || nodeType.length === 0) throw new Error('query.nodeType is required')

    const q = graph.query().type(nodeType).limit(limit)
    nodes.push(...(await collectAsync(q, limit)))

    if (query.traverse && typeof query.traverse === 'object') {
      const direction = query.traverse.direction || 'out'
      const relationType = query.traverse.relationType || query.traverse.type || null
      const edgeLimit = typeof query.traverse.limit === 'number' ? query.traverse.limit : 200

      for (const n of nodes) {
        const it = graph.edges(n.id, {
          direction,
          type: relationType || undefined,
          limit: edgeLimit
        })

        for await (const e of it) edges.push(e)
      }
    }
  } else if (query.type === 'nodeByAuthor') {
    const limit = typeof query.limit === 'number' ? query.limit : 100
    const author = query.author
    if (typeof author !== 'string' || author.length === 0) throw new Error('query.author is required')

    const q = graph.query().author(author).limit(limit)
    nodes.push(...(await collectAsync(q, limit)))
  } else if (query.type === 'expand') {
    const seedIds = Array.isArray(query.seedIds) ? query.seedIds : null
    if (!seedIds || seedIds.length === 0) throw new Error('query.seedIds must be a non-empty array')

    const direction = query.direction || 'out'
    const relationType = query.relationType || query.relationType === '' ? query.relationType : (query.type || null)
    const limit = typeof query.limit === 'number' ? query.limit : 200

    const seen = new Set()
    for (const id of seedIds) {
      if (typeof id !== 'string' || id.length === 0) continue
      const node = await graph.get(id)
      if (node) nodes.push(node)

      const it = graph.edges(id, {
        direction,
        type: relationType || undefined,
        limit
      })
      for await (const e of it) {
        const k = edgeKey(e)
        if (seen.has(k)) continue
        seen.add(k)
        edges.push(e)
      }
    }
  } else {
    throw new Error('Unsupported query.type')
  }

  const t1 = nowMs()

  return {
    profile: {
      durationMs: t1 - t0,
      contextsScanned: openedContexts.length,
      nodesReturned: nodes.length,
      edgesReturned: edges.length
    },
    openedContexts,
    graph: {
      nodes,
      edges
    }
  }
}
