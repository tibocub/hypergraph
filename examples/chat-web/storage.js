function shortKey (hex) {
  if (!hex) return ''
  return hex.slice(0, 8)
}

function parseDeterministicId (id) {
  // <type>/<coreKeyHex>/<seq>
  const parts = String(id).split('/')
  if (parts.length < 3) return null
  const seq = Number(parts[parts.length - 1])
  const coreKeyHex = parts[parts.length - 2]
  const type = parts.slice(0, parts.length - 2).join('/')
  return { type, coreKeyHex, seq }
}

module.exports = class ChatStorage {
  constructor (graph, opts = {}) {
    this.graph = graph
    this.messagesContext = opts.messagesContext
  }

  async setIdentity (profile) {
    return this.graph.setIdentity(profile)
  }

  async getIdentity (pubkey) {
    return this.graph.getIdentity(pubkey)
  }

  async createRoom (name) {
    const node = await this.graph.put({ type: 'room' })
    await this.graph.putContent(node.id, name, 'text')
    return node
  }

  async sendMessage (roomId, body) {
    const message = await this.graph.put({ type: 'message' })
    await this.graph.putContent(message.id, body, 'text')

    await this.graph.relate({
      from: message.id,
      to: roomId,
      type: 'message',
      context: this.messagesContext
    })

    return message
  }

  async listRooms () {
    const rooms = await this.graph.query().type('room').toArray()
    rooms.sort((a, b) => {
      const pa = parseDeterministicId(a.id)
      const pb = parseDeterministicId(b.id)
      if (!pa || !pb) return 0
      if (pa.coreKeyHex < pb.coreKeyHex) return -1
      if (pa.coreKeyHex > pb.coreKeyHex) return 1
      return pa.seq - pb.seq
    })
    return rooms
  }

  async getMessages (roomId) {
    const edges = []
    for await (const e of this.graph.edges(roomId, { direction: 'in', type: 'message' })) edges.push(e)

    const messages = []
    for (const e of edges) {
      const node = await this.graph.get(e.from)
      if (!node) continue
      const content = await this.graph.getContent(node.id)
      if (!content) continue
      messages.push({ node, content, edge: e })
    }

    messages.sort((a, b) => {
      const pa = parseDeterministicId(a.node.id)
      const pb = parseDeterministicId(b.node.id)
      if (!pa || !pb) return 0
      if (pa.coreKeyHex < pb.coreKeyHex) return -1
      if (pa.coreKeyHex > pb.coreKeyHex) return 1
      return pa.seq - pb.seq
    })

    return messages
  }

  displayAuthor (pubkey, identity) {
    if (identity && identity.username) return identity.username
    return shortKey(pubkey)
  }
}
