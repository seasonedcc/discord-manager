function requireSeeded<Value>(
  seeded: Record<string, Value>,
  key: string,
  what: string
) {
  const value = seeded[key]

  if (!value) {
    throw new Error(
      `The E2E seed needs the ${what} "${key}", but no journey seeded it`
    )
  }

  return value
}

export { requireSeeded }
