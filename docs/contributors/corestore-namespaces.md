# Corestore Namespaces

Corestore namespaces are used to isolate cores from different components, so that unrelated
Autobase-backed structures sharing one physical Corestore don't collide on the same internal
core name (they all use a fixed name, `'view'`, for their own materialized view — see
[Autobase Integration](autobase-integration.md)).

## Namespace Structure

```
Root Corestore
  ├── namespace('user:<keyHex>') → UserCore's Hypercore
  ├── namespace('<autobaseKeyHex or fresh-random>') → ContextBase's Autobase
  ├── namespace('scope-<autobaseKeyHex or fresh-random>') → ScopeBase's Autobase
  └── (no namespace — uses the raw store directly) → RoleBase's Autobase
```

## Important: RoleBase does NOT namespace

Unlike ContextBase and ScopeBase, **RoleBase constructs its Autobase directly on the raw
Corestore it's given, with no namespacing at all** (`new Autobase(this.#store, ...)`, not
`new Autobase(this.#store.namespace(...), ...)`). This was previously (incorrectly) documented
here as namespacing the same way ContextBase does — it doesn't, and that inaccuracy is worth
calling out explicitly rather than just quietly fixing, because it caused a real bug.

**The bug this caused**: `ScopeBase` (round 40), built by mirroring RoleBase's pattern, also
skipped namespacing initially. This hung — reproduced down to a minimal, two-raw-`Autobase`
script with no application code involved at all — because two un-namespaced Autobase
instances sharing one Corestore both try to use the same internal `"view"` core name.
`RoleBase` had gotten away with skipping namespacing for years only because it happened to be
the *only* thing in the whole system that did — nothing else was around to collide with it
until `ScopeBase` came along.

**The rule going forward**: any new Autobase-backed structure MUST namespace, the same way
`ContextBase` and `ScopeBase` do. Do not use `RoleBase`'s lack of namespacing as a template —
it's the one exception, not the pattern to copy, and it's only safe because there is (and
should remain) at most one un-namespaced Autobase in the whole system.

## Namespace Usage

**UserCore**:
```js
const core = store.get({ key: userCoreKey })
```

**ContextBase**:
```js
const ns = store.namespace(this.#namespace) // bootstrap key hex, or a fresh random id if new
const autobase = new Autobase(ns, bootstrapKey, opts)
```

**ScopeBase**:
```js
const ns = store.namespace(this.#namespace) // 'scope-' + (bootstrap key hex, or a fresh random id if new)
const autobase = new Autobase(ns, bootstrapKey, opts)
```

**RoleBase** (the one exception — see above):
```js
const autobase = new Autobase(store, bootstrapKey, opts) // no namespace at all
```

## A separate, more fundamental limitation

Namespacing solves *one* Autobase from colliding with a *different* one on the same Corestore.
It does not help with a different problem: **two separate object instances of the *same*
Autobase key can never share one Corestore at all** — confirmed directly with a minimal
repro (hangs immediately, regardless of namespacing). This is why every cross-peer test in
this codebase uses separate Corestores with real replication between them (`store.replicate()`)
rather than trying to open the same context/RoleBase/ScopeBase key twice against one store.

## Critical Detail

Namespaces prevent core key conflicts between different Autobase-backed structures sharing
one Corestore. They do not, and cannot, make it safe to open the same Autobase key twice
against that same Corestore (see above).

## See Also

- [Autobase Integration](autobase-integration.md) - How ContextBase/RoleBase/ScopeBase use Autobase
