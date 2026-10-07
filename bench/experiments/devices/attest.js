// Experiment 4 (design brief): several devices per member, one log per device.
// A reader must check, once per device log, that the device belongs to the
// member's identity (keet-identity-key proof, as v1 does). This measures the
// proof's size and the time to check it, for a device attested directly by
// the identity (first device) and one attested by another device (chain of 2).
//
//   node bench/experiments/devices/attest.js

const IdentityKey = require('keet-identity-key')
const crypto = require('hypercore-crypto')

const now = () => Number(process.hrtime.bigint()) / 1e6

async function main () {
  const identity = await IdentityKey.from({ mnemonic: IdentityKey.generateMnemonic() })
  const first = crypto.keyPair()
  const firstProof = await identity.bootstrap(first.publicKey)
  const second = crypto.keyPair()
  const secondProof = IdentityKey.attestDevice(second.publicKey, first, firstProof)

  const results = {}
  for (const [name, proof] of [['first device', firstProof], ['device attested by a device', secondProof]]) {
    const info = IdentityKey.verify(proof, null)
    if (!info || !info.identityPublicKey.equals(identity.identityPublicKey)) throw new Error('proof did not verify')
    const n = 2000
    const t0 = now()
    for (let i = 0; i < n; i++) IdentityKey.verify(proof, null)
    results[name] = { proofBytes: proof.byteLength, verifyMs: +((now() - t0) / n).toFixed(3) }
  }
  console.log(JSON.stringify(results))
}

main().catch((err) => { console.error(err); process.exit(1) })
