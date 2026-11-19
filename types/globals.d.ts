// Node and Bare both take null here (lib/ clears timers that may not be set yet).
declare function clearTimeout (timeout: ReturnType<typeof setTimeout> | null | undefined): void
declare function clearInterval (timeout: ReturnType<typeof setInterval> | null | undefined): void
