// The local index's writer (research R12): logs → gate → rows.

// One write queue per instance: every change to the index runs alone, in a
// transaction committed at its end (the spike: HyperDB refuses to commit
// during another insert). A task that throws commits nothing.
class WriteQueue {
  constructor (db) {
    this.db = db
    this.tail = Promise.resolve()
  }

  run (fn) {
    const task = this.tail.then(async () => {
      const tx = this.db.transaction()
      try {
        const result = await fn(tx)
        await tx.flush()
        return result
      } catch (err) {
        await tx.close()
        throw err
      }
    })
    this.tail = task.catch(() => {})
    return task
  }

  // Resolves when everything queued so far is committed.
  idle () {
    return this.tail
  }
}

module.exports = { WriteQueue }
