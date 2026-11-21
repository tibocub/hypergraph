// The parts of hypercore lib/ uses.
declare module 'hypercore' {
  import { EventEmitter } from 'events'
  import { Duplex } from 'stream'

  namespace Hypercore {
    interface KeyPair { publicKey: Uint8Array, secretKey: Uint8Array }
    interface Peer { remotePublicKey: Uint8Array, remoteContiguousLength: number, remoteLength: number, remoteFork: number, remoteSynced: boolean }
    interface GetOptions { wait?: boolean, timeout?: number, valueEncoding?: unknown, decrypt?: boolean }
    interface Range { start?: number, end?: number, blocks?: number[], linear?: boolean }
    interface Download { done (): Promise<void>, destroy (): void }
    interface Manifest { version?: number, signers: { publicKey: Uint8Array }[] }
  }

  class Hypercore extends EventEmitter {
    constructor (storage: unknown, key?: Uint8Array | null, opts?: object)
    static key (manifest: Hypercore.Manifest | Uint8Array, opts?: object): Uint8Array
    static discoveryKey (key: Uint8Array): Uint8Array
    readonly key: Uint8Array
    readonly discoveryKey: Uint8Array
    readonly keyPair: { publicKey: Uint8Array, secretKey: Uint8Array | null } | null
    readonly length: number
    readonly contiguousLength: number
    readonly signedLength: number
    readonly byteLength: number
    /** Set when the core encrypts its blocks (an encryption key was given). */
    readonly encryption: object | null
    readonly fork: number
    readonly writable: boolean
    readonly readable: boolean
    readonly opened: boolean
    readonly closing: Promise<void> | null
    readonly closed: boolean
    readonly peers: Hypercore.Peer[]
    /** Internal: tells peers which blocks are held. */
    readonly replicator: { onhave (start: number, length: number): void } | null
    ready (): Promise<void>
    close (): Promise<void>
    get (index: number, opts?: Hypercore.GetOptions): Promise<Uint8Array | null>
    has (start: number, end?: number): Promise<boolean>
    append (blocks: Uint8Array | Uint8Array[]): Promise<{ length: number, byteLength: number }>
    update (opts?: { wait?: boolean }): Promise<boolean>
    clear (start: number, end?: number, opts?: object): Promise<unknown>
    download (range?: Hypercore.Range): Hypercore.Download
    session (opts?: object): Hypercore
    snapshot (opts?: object): Hypercore
    replicate (isInitiator: boolean | Duplex, opts?: object): Duplex
  }

  export = Hypercore
}
