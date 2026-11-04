import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { type CompiledQuery, sql } from 'kysely'
import { vi } from 'vitest'
import { db } from '~/db/db.server'
import { env } from '~/framework/env.server'

async function statementsRunBy(read: () => Promise<unknown>) {
  const executeQuery = vi.spyOn(db().getExecutor(), 'executeQuery')

  try {
    await read()

    return executeQuery.mock.calls.map(([statement]) => statement)
  } finally {
    executeQuery.mockRestore()
  }
}

async function copyWithStatistics() {
  const copyPath = path.join(
    path.dirname(env().databasePath),
    `${randomUUID()}.db`
  )

  await sql`vacuum into ${copyPath}`.execute(db())

  const copy = new Database(copyPath)
  copy.exec('analyze')

  return copy
}

function stepsOf(store: Database.Database, statement: CompiledQuery) {
  const steps = store
    .prepare(`explain query plan ${statement.sql}`)
    .all(...statement.parameters) as { detail: string }[]

  return steps.map(({ detail }) => detail)
}

async function plansOf(read: () => Promise<unknown>) {
  const statements = await statementsRunBy(read)
  const withoutStatistics = new Database(env().databasePath, {
    readonly: true,
  })
  const withStatistics = await copyWithStatistics()

  try {
    return [
      {
        statistics: 'never gathered',
        steps: statements.flatMap((statement) =>
          stepsOf(withoutStatistics, statement)
        ),
      },
      {
        statistics: 'gathered',
        steps: statements.flatMap((statement) =>
          stepsOf(withStatistics, statement)
        ),
      },
    ]
  } finally {
    withoutStatistics.close()
    withStatistics.close()
  }
}

function wholeTableSteps(steps: string[], tables: string[]) {
  return steps.filter(
    (step) =>
      step.includes('AUTOMATIC') ||
      tables.some(
        (table) => step.startsWith(`SCAN ${table} `) || step === `SCAN ${table}`
      )
  )
}

export { plansOf, wholeTableSteps }
