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
  └── namespace('role-<autobaseKeyHex or fresh-random>') → RoleBase's Autobase
```

**Every** Autobase-backed structure in the system namespaces its own Corestore session. This
wasn't always true — `RoleBase` originally constructed its Autobase directly on the raw
Corestore session it was given, with no namespacing at all. This caused two separate, real
bugs, in order:

**Bug 1**: `ScopeBase`, built by mirroring `RoleBase`'s (un-namespaced) pattern, hung —
reproduced down to a minimal, two-raw-`Autobase` script with no application code involved —
because two un-namespaced Autobase instances sharing one Corestore both try to use the same
internal `"view"` core name. Fixed by namespacing `ScopeBase`. `RoleBase` itself was left
un-namespaced at the time, since nothing else in the system shared a Corestore session with it
directly the same way.

**Bug 2, more serious**: confirmed directly that closing a `RoleBase` *alone* — no other
component involved — closed the entire shared Corestore session out from under every other
consumer of it (`UserCore`, any open `ContextBase`, subsequent `createContext()` calls), all
of which started throwing `"Corestore is closed"` on their very next operation. The mechanism:
a Corestore *session* (what `.namespace()` returns) has its own, isolated `close()` that only
tears down its own child sessions — but the raw session `RoleBase` was given was the exact
same object every other consumer of the graph was also holding a reference to, so Autobase's
own internal close (triggered by `roleBase.close()`) closed that shared object out from under
everyone. Confirmed empirically, then fixed by namespacing `RoleBase` too — closing a
namespaced session only affects its own children, never a sibling or the shared parent (see
"A separate, more fundamental limitation" below for the isolation semantics this relies on).

**The rule, now consistent for every Autobase-backed structure**: always namespace. There is
no longer an exception anywhere in this system, and there shouldn't be one added — an
un-namespaced Autobase sharing a Corestore session with anything else is what caused both bugs
above.

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

**RoleBase**:
```js
const ns = store.namespace(this.#namespace) // 'role-new-' + a fresh random id if new, or the bootstrap key hex
const autobase = new Autobase(ns, bootstrapKey, opts)
```

## A separate, more fundamental limitation

Namespacing solves *one* Autobase from colliding with a *different* one on the same Corestore,
and — as bug 2 above showed — it's also what keeps closing one Autobase-backed structure from
taking down everything else sharing that Corestore. It does not help with a different problem:
**two separate object instances of the *same* Autobase key can never share one Corestore at
all** — confirmed directly with a minimal repro (hangs immediately, regardless of namespacing).
This is why every cross-peer test in this codebase uses separate Corestores with real
replication between them (`store.replicate()`) rather than trying to open the same
context/RoleBase/ScopeBase key twice against one store.

## Critical Detail

Namespaces prevent core key conflicts between different Autobase-backed structures sharing
one Corestore, and isolate each one's `close()` from affecting anything else sharing that
Corestore. They do not, and cannot, make it safe to open the same Autobase key twice against
that same Corestore (see above).

## See Also

- [Autobase Integration](autobase-integration.md) - How ContextBase/RoleBase/ScopeBase use Autobase
