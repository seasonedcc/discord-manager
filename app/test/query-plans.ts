import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { type CompiledQuery, sql } from 'kysely'
import { env } from '~/framework/env.server'
import { db, vi } from './prelude'

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

function branchesOf(store: Database.Database, statement: CompiledQuery) {
  const steps = store
    .prepare(`explain query plan ${statement.sql}`)
    .all(...statement.parameters) as { parent: number; detail: string }[]
  const parents = [...new Set(steps.map(({ parent }) => parent))]

  return parents.map((parent) =>
    steps.filter((step) => step.parent === parent).map(({ detail }) => detail)
  )
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
        branches: statements.flatMap((statement) =>
          branchesOf(withoutStatistics, statement)
        ),
      },
      {
        statistics: 'gathered',
        branches: statements.flatMap((statement) =>
          branchesOf(withStatistics, statement)
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

function lookupsSortingTheirTieBreak(branches: string[][], tables: string[]) {
  return branches.filter(
    (steps) =>
      steps.includes('USE TEMP B-TREE FOR LAST TERM OF ORDER BY') &&
      steps.some((step) =>
        tables.some((table) => step.startsWith(`SEARCH ${table} `))
      )
  )
}

export { lookupsSortingTheirTieBreak, plansOf, wholeTableSteps }
