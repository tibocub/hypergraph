// Packages lib/ uses that ship no types: typed loosely here; the core ones have their own file.
declare module 'blind-pairing'
declare module 'blind-peer' {
  const BlindPeer: new (...args: any[]) => any // lib/holding.js extends it
  export = BlindPeer
}
declare module 'blind-peering'
declare module 'hyperbee'
declare module 'hypercore-crypto'
declare module 'hyperdb'
declare module 'hyperdb/builder'
declare module 'hyperdb/runtime'
declare module 'hyperdht/testnet'
declare module 'keet-identity-key'
declare module 'keet-identity-key/lib/encoding.js'
declare module 'protomux-rpc'
declare module 'protomux-wakeup'
declare module 'safety-catch'
declare module 'sodium-universal'
declare module 'z32'
declare module 'hyperschema'
