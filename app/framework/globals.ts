const globalStore = globalThis as unknown as {
  __appGlobals?: Map<string, unknown>
}

function appGlobals() {
  if (!globalStore.__appGlobals) {
    globalStore.__appGlobals = new Map<string, unknown>()
  }

  return globalStore.__appGlobals
}

function getOrSetGlobal<T>(key: string, create: () => T) {
  const store = appGlobals()

  if (!store.has(key)) {
    store.set(key, create())
  }

  return store.get(key) as T
}

function mutateGlobal<T>(key: string, value: T) {
  appGlobals().set(key, value)
}

export { getOrSetGlobal, mutateGlobal }
