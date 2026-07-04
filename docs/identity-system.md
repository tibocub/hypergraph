# Identity System

Hypergraph includes a comprehensive identity system built on keet-identity-key for multi-device support and mnemonic recovery.

## Identity vs Device Keys

- **Identity key**: Long-term cryptographic identity (same across all devices)
- **Device key**: Per-device keypair (each device has its own)
- **Attestation proof**: Cryptographic proof that a device belongs to an identity

## Multi-Device Support

Each device has its own UserCore, but all devices share the same identity:

```
Device 1: UserCore key = device1PublicKey, identity = identityPublicKey
Device 2: UserCore key = device2PublicKey, identity = identityPublicKey
```

The view maintains a device-to-identity mapping for author resolution.

## Mnemonic Recovery

Identity can be recovered from a 12-word mnemonic phrase:

```js
const graph = new Hypergraph(store, { mnemonic: 'word1 word2 ... word12' })
```

This allows users to restore their identity across devices without needing to backup private keys.

## Opening Remote User Cores

To open another device's core:

```js
await graph.openUserCore(remoteDeviceKeyHex)
```

This creates a UserCore instance for the remote device without a keyPair (read-only).

## Author Resolution

When querying entities, Hypergraph resolves device keys to identity keys using the device-to-identity mapping. This ensures that entities from multiple devices of the same user are grouped correctly.

## See Also

- [Glossary](glossary.md) - Identity key vs device key terminology
- [Storage Model](storage-model.md) - How identity data is stored
