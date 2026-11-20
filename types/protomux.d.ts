// The parts of protomux lib/ uses. A module, not `declare module 'protomux'`: another package
// declaring protomux too would clash with it (duplicate `export =`) in its users' builds.
import { Duplex } from 'stream'

declare namespace Protomux {
  interface Message { send (value: unknown): boolean }
  interface MessageOptions { encoding?: unknown, onmessage?: (value: any, channel: Channel) => void }
  interface Channel {
    readonly opened: boolean
    readonly closed: boolean
    readonly messages: Message[]
    userData: unknown
    open (handshake?: unknown): void
    close (): void
    addMessage (opts?: MessageOptions): Message
  }
  interface ChannelOptions {
    protocol: string
    id?: Uint8Array | null
    handshake?: unknown
    unique?: boolean
    messages?: MessageOptions[]
    onopen?: (handshake: any, channel: Channel) => void
    onclose?: (isRemote: boolean, channel: Channel) => void
    ondestroy?: (channel: Channel) => void
  }
}

declare class Protomux {
  static from (stream: Duplex, opts?: object): Protomux
  readonly stream: Duplex & { remotePublicKey: Uint8Array, publicKey: Uint8Array, isInitiator: boolean, handshakeHash: Uint8Array }
  createChannel (opts: Protomux.ChannelOptions): Protomux.Channel | null
  pair (opts: { protocol: string, id?: Uint8Array | null }, notify: (id: Uint8Array | null) => void): void
  unpair (opts: { protocol: string, id?: Uint8Array | null }): void
  opened (opts: { protocol: string, id?: Uint8Array | null }): boolean
}

export = Protomux
