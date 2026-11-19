// The parts of corestore lib/ uses.
declare module 'corestore' {
  import { EventEmitter } from 'events'
  import { Duplex } from 'stream'
  import Hypercore = require('hypercore')

  namespace Corestore {
    interface GetOptions { name?: string, key?: Uint8Array | null, keyPair?: Hypercore.KeyPair, encryption?: { key: Uint8Array }, valueEncoding?: unknown, exclusive?: boolean, active?: boolean, wait?: boolean, manifest?: object }
  }

  class Corestore extends EventEmitter {
    constructor (storage: string | object, opts?: { readOnly?: boolean, primaryKey?: Uint8Array })
    readonly manifestVersion: number
    /** Internal: its RocksDB storage. */
    readonly storage: { db: { compactRange (opts?: object): Promise<void> } }
    ready (): Promise<void>
    close (): Promise<void>
    get (opts: Corestore.GetOptions | Uint8Array | string): Hypercore
    namespace (name: string | Uint8Array): Corestore
    session (opts?: object): Corestore
    replicate (isInitiator: boolean | Duplex, opts?: object): Duplex
    createKeyPair (name: string, ns?: Uint8Array): Promise<Hypercore.KeyPair>
  }

  export = Corestore
}
