# Data Flow

## Write Path (Creating an Entity)

```
1. graph.put({ type: 'post' })
   ↓
2. UserCore.append(event)
   ↓
3. Event encoded via encodeEvent()
   ↓
4. Written to user's Hypercore
   ↓
5. graph.update() called by application
   ↓
6. GraphView processes new events from UserCore
   ↓
7. Indexes updated in GraphView's Hyperbee
```

## Write Path (Creating a Relation)

```
1. graph.relate({ from, to, type, context })
   ↓
2. ContextBase.append(event)
   ↓
3. Event encoded via encodeEvent()
   ↓
4. Written to context's Autobase (local writer core)
   ↓
5. graph.update() called by application
   ↓
6. GraphView processes new events from ContextBase
   ↓
7. Indexes updated in GraphView's Hyperbee
```

## Read Path (Querying)

```
1. graph.query().type('post').toArray()
   ↓
2. GraphQuery builds index range query
   ↓
3. GraphView.bee.get() on index (e.g., nt:post:...)
   ↓
4. Returns matching entity IDs
   ↓
5. GraphView.bee.get() on node records (n:<id>)
   ↓
6. Returns full entity data
```

## See Also

- [Architecture Overview](architecture-overview.md) - Component overview
- [Component Details](component-details.md) - Detailed internals of each component
