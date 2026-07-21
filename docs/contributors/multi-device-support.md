# Multi-Device Support

Hypergraph supports multiple devices per identity through the IdentityManager.

## Identity vs Device Keys

- **Identity key**: Long-term cryptographic identity (same across all devices), derived from
  a 12-word mnemonic
- **Device key**: Per-device signing keypair (Ed25519) — confirmed genuinely random and
  different on every device, NOT derived from the mnemonic at all
- **Encryption keypair**: A *different* per-identity (not per-device) keypair (X25519 /
  `crypto_box`), deterministically derived from the same mnemonic — used for sealing secrets
  (e.g. a read-scope's key) so any of the identity's devices can independently open them. See
  [Read Permission](../read-permission.md). Deliberately NOT per-device: a granter only needs
  to seal a secret once per *person*, not once per device
- **Attestation proof**: Cryptographic proof that a specific (random) device key belongs to
  the mnemonic-derived identity

## Device-to-Identity Mapping

GraphView maintains a mapping from device keys to identity keys, registered automatically
during `Hypergraph`'s own initialization — this is internal, not something an app calls
directly:

```js
// Called automatically inside Hypergraph's _open() — not a public API
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

## Syncing a New Device

There's no dedicated "pairing" API in hypergraph itself — restoring the same identity on a
new device is just constructing it with the same mnemonic:

```js
const graph = new Hypergraph(store, { mnemonic })
```

Any UX around this (QR codes, a "link a device" flow, etc.) is entirely an application-layer
concern — a QR code is just a different encoding of the same mnemonic string, scanned instead
of typed. Hypergraph's part of this is already complete; nothing new is needed at the
hypergraph level for the basic case.

## See Also

- [Component Details](component-details.md) - IdentityManager details
- [Read Permission](../read-permission.md) - encryptionKeyPair and how it's used for scope key grants
