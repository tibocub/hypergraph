// The parts of autobase lib/ uses.
declare module 'autobase' {
  import { EventEmitter } from 'events'
  import Corestore = require('corestore')
  import Hypercore = require('hypercore')

  namespace Autobase {
    interface Node { value: Uint8Array, from: { key: Uint8Array }, length: number }
    interface Writer { core: Hypercore, length: number }
    interface Host {
      addWriter (key: Uint8Array, opts?: { indexer?: boolean }): Promise<void>
      removeWriter (key: Uint8Array): Promise<void>
      removeable (key: Uint8Array): boolean
      interrupt (reason?: string): void
    }
    interface Options<V> {
      keyPair?: Hypercore.KeyPair
      encryptionKey?: Uint8Array
      valueEncoding?: unknown
      ackInterval?: number
      ackThreshold?: number
      wakeup?: unknown
      open (store: Corestore): V
      apply (nodes: Node[], view: V, host: Host): Promise<void>
    }
  }

  class Autobase<V = unknown> extends EventEmitter {
    constructor (store: Corestore, key: Uint8Array | null, opts: Autobase.Options<V>)
    static getLocalKey (store: Corestore): Promise<Uint8Array>
    readonly key: Uint8Array
    readonly discoveryKey: Uint8Array
    readonly local: Hypercore
    readonly store: Corestore
    readonly view: V
    readonly writable: boolean
    readonly length: number
    readonly indexedLength: number
    readonly activeWriters: Iterable<Autobase.Writer> & { get (key: Uint8Array): Autobase.Writer | null, size: number }
    readonly opened: boolean
    readonly system: { list (): AsyncIterable<{ key: Uint8Array }> }
    readonly linearizer: { indexers: Autobase.Writer[] } | null
    views (): Iterable<{ key: Uint8Array }>
    ready (): Promise<void>
    close (): Promise<void>
    update (): Promise<void>
    append (value: Uint8Array | Uint8Array[] | null): Promise<unknown>
    hintWakeup (peers: unknown): void
  }

  export = Autobase
}
