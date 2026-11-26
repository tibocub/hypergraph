// The parts of @hyperswarm/secret-stream lib/i2p/ uses.
declare module '@hyperswarm/secret-stream' {
  import { Duplex } from 'stream'

  class NoiseSecretStream extends Duplex {
    /** autoStart: false to call start() later, once the raw stream exists. */
    constructor (isInitiator: boolean, rawStream: Duplex | null, opts?: { keyPair?: { publicKey: Uint8Array, secretKey: Uint8Array }, remotePublicKey?: Uint8Array, autoStart?: boolean })
    readonly isInitiator: boolean
    /** Set once the handshake is done. */
    remotePublicKey: Uint8Array
    publicKey: Uint8Array
    /** True once the handshake is done, false if the stream closed first. */
    readonly opened: Promise<boolean>
    rawStream: Duplex | null
    userData: any
    start (rawStream: Duplex, opts?: { keyPair?: { publicKey: Uint8Array, secretKey: Uint8Array } }): void
  }
  export = NoiseSecretStream
}
