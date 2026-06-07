- Implement JSDoc type checking and documentation

## Identity fixes
- use can() from Autobase instead of custom logic
- Combine with entity authorship checks
- Implement dedicated auth middleware for APIs

```
// Express endpoint
app.post('/verify-identity/:pubkey', async (req, res) => {
  try {
    const { pubkey } = req.params
    const graph = getGraph() // Your existing Autobase graph instance
    const pubKey = Buffer.from(pubkey, 'hex') // Ensure proper format

    // Check if a valid role exists for this user
    const roleBase = await graph.openRoleBase(roleBaseKey)
    const registry = await roleBase.getRegistry()
    
    // Use built-in permission check
    const canRead = await canRole(registry, pubkey, 'read')
    const canWrite = await canRole(registry, pubkey, 'write')
    let canTag = false
    if (registry && registry.tags) {
      canTag = await canRole(registry.tags, pubkey, 'tag')
    }
    
    res.json({ 
      isValidAccount: true,
      canRead,
      canWrite,
      canTag,
      role: registry && registry.roles ? registry.getRole(pubkey) : null
    })
  } catch (error) {
    console.error('Identity check failed:', error)
    res.status(404).json({ message: 'Invalid or restricted account' })
  }
})
```
- Batch Operations - Add efficient bulk operations
- Batch Relations - Add batch relate/unrelate methods
- Batch Tags - Add batch tag/untag methods
- Statistics/Metrics - Add useful query statistics
- Cleanup methods - Context/user core management
