// The parts of hyperswarm lib/ uses.
declare module 'hyperswarm' {
  import { EventEmitter } from 'events'
  import { Duplex } from 'stream'

  namespace Hyperswarm {
    interface KeyPair { publicKey: Uint8Array, secretKey: Uint8Array }
    /** An encrypted stream to one peer. */
    interface Connection extends Duplex {
      remotePublicKey: Uint8Array
      publicKey: Uint8Array
      isInitiator: boolean
      /** The Protomux corestore.replicate() put on it. */
      userData: import('protomux')
    }
    interface PeerInfo { publicKey: Uint8Array, topics: Uint8Array[], client: boolean }
    interface Discovery { readonly destroyed: boolean, flushed (): Promise<void>, refresh (opts?: JoinOptions): Promise<void>, destroy (): Promise<void> }
    interface JoinOptions { server?: boolean, client?: boolean }
  }

  class Hyperswarm extends EventEmitter {
    constructor (opts?: { keyPair?: Hyperswarm.KeyPair, bootstrap?: unknown })
    readonly keyPair: Hyperswarm.KeyPair
    readonly dht: { destroyed: boolean, bootstrapped: boolean, destroy (): Promise<void> }
    readonly connections: Set<Hyperswarm.Connection>
    join (topic: Uint8Array, opts?: Hyperswarm.JoinOptions): Hyperswarm.Discovery
    leave (topic: Uint8Array): Promise<void>
    joinPeer (publicKey: Uint8Array): void
    leavePeer (publicKey: Uint8Array): void
    listen (): Promise<void>
    flush (): Promise<void>
    suspend (): Promise<void>
    resume (): Promise<void>
    destroy (opts?: { force?: boolean }): Promise<void>
  }

  export = Hyperswarm
}
