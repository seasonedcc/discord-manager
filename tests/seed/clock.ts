import { sql } from 'kysely'
import { db } from '~/db/db.server'

async function readTheStoreInstant() {
  const { rows } = await sql<{
    instant: string
  }>`select strftime('%Y-%m-%dT%H:%M:%fZ','now') as instant`.execute(db())
  const [row] = rows

  if (!row) throw new Error('The store answered no instant')

  return row.instant
}

// Two events written in the same millisecond tie on createdAt, and every
// reading that orders by it then falls through to whatever tie-break it has —
// which is not the order the feed intended. Letting the store's own clock tick
// between events keeps seeded history in the order it was fed, with no
// wall-clock wait.
async function waitForTheStoreClockToTick() {
  const before = await readTheStoreInstant()
  let instant = before

  while (instant === before) instant = await readTheStoreInstant()
}

async function readClock() {
  const anchor = await readTheStoreInstant()

  return {
    anchor,
    at(minutesAfterTheAnchor: number) {
      return new Date(
        Date.parse(anchor) + minutesAfterTheAnchor * 60_000
      ).toISOString()
    },
  }
}

type Clock = Awaited<ReturnType<typeof readClock>>

export { readClock, readTheStoreInstant, waitForTheStoreClockToTick }
export type { Clock }
