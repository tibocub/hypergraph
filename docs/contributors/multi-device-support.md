# Multi-Device Support

Hypergraph supports multiple devices per identity through the IdentityManager.

## Identity vs Device Keys

- **Identity key**: Long-term cryptographic identity (same across all devices)
- **Device key**: Per-device keypair (each device has its own)
- **Attestation proof**: Cryptographic proof that a device belongs to an identity

## Device-to-Identity Mapping

GraphView maintains a mapping from device keys to identity keys:

```js
view.registerDeviceIdentity(deviceKeyHex, identityKeyHex)
```

This mapping is used for author resolution in queries.

## UserCore Per Device

Each device has its own UserCore, but all devices share the same identity:

```
Device 1: UserCore key = device1PublicKey, identity = identityPublicKey
Device 2: UserCore key = device2PublicKey, identity = identityPublicKey
```

## Opening Remote User Cores

To open another device's core:

```js
await graph.openUserCore(remoteDeviceKeyHex)
```

This creates a UserCore instance for the remote device without a keyPair (read-only).

## See Also

- [Component Details](component-details.md) - IdentityManager details
