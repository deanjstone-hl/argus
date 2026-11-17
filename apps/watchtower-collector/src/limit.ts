// Runs at most `max` tasks at once; the rest wait their turn in arrival order.
// Used to keep a burst of child processes from all being alive together.
export function createLimiter(max: number) {
  let active = 0
  const waiting: Array<() => void> = []

  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve))
    else active += 1
    try {
      return await task()
    } finally {
      // Hand the slot straight to the next waiter so a newcomer cannot slip in between.
      const next = waiting.shift()
      if (next) next()
      else active -= 1
    }
  }
}
