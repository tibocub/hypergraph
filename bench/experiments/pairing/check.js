// Spec 011, task T002 (research R9): does blind-pairing work for "join by
// code" on Node and on Bare? Pairs two local instances over a local DHT:
// device A shows a code, device B uses it and sends its device key, A answers
// with a key (the personal space's) and some data (the device proof), B gets
// both. Then a second use of the same code is refused.
//
//   node bench/experiments/pairing/check.js
//   bare bench/experiments/pairing/check.js

const createTestnet = require('hyperdht/testnet')
const Hyperswarm = require('hyperswarm')
const BlindPairing = require('blind-pairing')
const crypto = require('hypercore-crypto')
const b4a = require('b4a')
const z32 = require('z32')

const runtime = typeof Bare !== 'undefined' ? 'bare' : 'node' // eslint-disable-line no-undef

async function main () {
  const testnet = await createTestnet(3)
  const started = Date.now()
  const spaceKey = crypto.randomBytes(32)
  const proof = b4a.from('a device proof would go here')
  const { invite, publicKey, discoveryKey } = BlindPairing.createInvite(spaceKey)
  const code = z32.encode(invite)

  const swarmA = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const swarmB = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const a = new BlindPairing(swarmA, { poll: 1000 })
  const b = new BlindPairing(swarmB, { poll: 1000 })

  let uses = 0
  const deviceB = crypto.keyPair().publicKey
  const member = a.addMember({
    discoveryKey,
    async onadd (candidate) {
      candidate.open(publicKey)
      if (uses++ > 0) return candidate.deny()
      const data = proof
      candidate.confirm({ key: spaceKey, additional: { data, signature: crypto.sign(data, crypto.keyPair(BlindPairing.decodeInvite(invite).seed).secretKey) } })
    }
  })
  await member.flushed()

  const candidate = b.addCandidate({ invite: z32.decode(code), userData: deviceB, async onadd () {} })
  const result = await candidate.pairing
  const paired = b4a.equals(result.key, spaceKey) && b4a.equals(result.data, proof)

  // The same code again: the member denies it, but blind-pairing swallows a
  // refusal on the candidate side and keeps polling, so the candidate only
  // learns it by not being paired within a bound.
  const swarmC = new Hyperswarm({ bootstrap: testnet.bootstrap })
  const cPairing = new BlindPairing(swarmC, { poll: 1000 })
  const again = cPairing.addCandidate({ invite: z32.decode(code), userData: crypto.keyPair().publicKey, async onadd () {} })
  let timer = null
  const second = await Promise.race([again.pairing, new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), 5000) })])
  clearTimeout(timer)
  await again.close()
  const secondRefused = second === 'timeout' && uses === 2

  console.log(JSON.stringify({ runtime, paired, secondRefused, secondDenied: uses === 2, codeChars: code.length, ms: Date.now() - started }))

  await a.close(); await b.close(); await cPairing.close()
  await swarmA.destroy(); await swarmB.destroy(); await swarmC.destroy()
  await testnet.destroy()
}

main()
