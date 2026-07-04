# Corestore Namespaces

Corestore namespaces are used to isolate cores from different components.

## Namespace Structure

```
Root Corestore
  ├── namespace('user:<keyHex>') → UserCore's Hypercore
  ├── namespace('ctx:<autobaseKeyHex>') → ContextBase's Autobase
  └── namespace('role:<roleBaseKeyHex>') → RoleBase's Autobase
```

## Namespace Usage

**UserCore**:
```js
const core = store.get({ key: userCoreKey })
```

**ContextBase**:
```js
const ns = store.namespace(this.#namespace) // namespace = autobaseKeyHex
const autobase = new Autobase(ns, bootstrapKey, opts)
```

**RoleBase**:
```js
const ns = store.namespace(this.#namespace) // namespace = roleBaseKeyHex
const autobase = new Autobase(ns, bootstrapKey, opts)
```

## Critical Detail

Namespaces prevent core key conflicts between different contexts and RoleBase instances.

## See Also

- [Autobase Integration](autobase-integration.md) - How ContextBase uses Autobase
