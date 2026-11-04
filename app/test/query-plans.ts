import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { type CompiledQuery, DefaultQueryExecutor, sql } from 'kysely'
import { env } from '~/framework/env.server'
import { db, expect, vi } from './prelude'

type PlanStep = { id: number; parent: number; detail: string; table?: string }

const subquery = /^(?:CORRELATED )?(?:SCALAR|LIST) SUBQUERY/
const derivedTable = /^(?:CO-ROUTINE|MATERIALIZE) (\S+)/
const guildTable = 'guilds'

async function statementsRunBy(read: () => Promise<unknown>) {
  const executeQuery = vi.spyOn(DefaultQueryExecutor.prototype, 'executeQuery')

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

function plannerOf(store: Database.Database) {
  const tablesByIndex = new Map(
    (
      store
        .prepare(
          `select name, tbl_name as "table" from sqlite_schema where type = 'index'`
        )
        .all() as { name: string; table: string }[]
    ).map(({ name, table }) => [name, table])
  )

  return (statement: CompiledQuery) =>
    (
      store
        .prepare(`explain query plan ${statement.sql}`)
        .all(...statement.parameters) as PlanStep[]
    ).map((step) => {
      const tableRead =
        /^(?:SEARCH|SCAN) (?!CONSTANT ROW$)(\S+)(?:.* USING (?:COVERING )?INDEX (\S+))?/.exec(
          step.detail
        )

      return tableRead
        ? { ...step, table: tablesByIndex.get(tableRead[2]) ?? tableRead[1] }
        : step
    })
}

async function plansOf(statements: CompiledQuery[]) {
  const withoutStatistics = new Database(env().databasePath, {
    readonly: true,
  })
  const withStatistics = await copyWithStatistics()

  try {
    return [
      {
        statistics: 'never gathered',
        plans: statements.map(plannerOf(withoutStatistics)),
      },
      {
        statistics: 'gathered',
        plans: statements.map(plannerOf(withStatistics)),
      },
    ]
  } finally {
    withoutStatistics.close()
    withStatistics.close()
  }
}

function derivedTablesIn(plan: PlanStep[]) {
  return plan.flatMap(({ detail }) => derivedTable.exec(detail)?.slice(1) ?? [])
}

function wholeTableReadsBeyond(plan: PlanStep[], allowedScans: string[]) {
  const derivedTables = derivedTablesIn(plan)

  return plan
    .filter(({ detail }) => {
      const scanned = /^SCAN (\S+)/.exec(detail)?.[1]

      return (
        detail.includes('AUTOMATIC') ||
        (scanned !== undefined &&
          detail !== 'SCAN CONSTANT ROW' &&
          ![...derivedTables, ...allowedScans].includes(scanned))
      )
    })
    .map(({ detail }) => detail)
}

function lookupsThatSort(plan: PlanStep[], latestStateTables: string[]) {
  const derivedTables = derivedTablesIn(plan)
  const isNestedSelect = ({ detail }: PlanStep) =>
    subquery.test(detail) || derivedTable.test(detail)
  const childrenOf = (id: number) => plan.filter(({ parent }) => parent === id)
  const scopeOf = (id: number): PlanStep[] =>
    childrenOf(id).flatMap((step) =>
      subquery.test(step.detail) ? [] : [step, ...scopeOf(step.id)]
    )
  const sortsOf = (id: number): PlanStep[] =>
    childrenOf(id).flatMap((step) => {
      if (step.detail.startsWith('USE TEMP B-TREE')) return [step]

      return isNestedSelect(step) ? [] : sortsOf(step.id)
    })
  const statement = { id: 0, detail: 'the statement itself' }

  return [statement, ...plan.filter(isNestedSelect)]
    .filter((root) => {
      const tables = scopeOf(root.id).flatMap(({ table }) =>
        table === undefined || derivedTables.includes(table) ? [] : [table]
      )
      const looksUp = tables.some((table) => latestStateTables.includes(table))
      const onlyLooksUp = tables.every(
        (table) => latestStateTables.includes(table) || table === guildTable
      )

      return (
        looksUp &&
        (root !== statement || onlyLooksUp) &&
        sortsOf(root.id).length > 0
      )
    })
    .map((root) => [
      root.detail,
      ...scopeOf(root.id).map(({ detail }) => detail),
    ])
}

async function expectEveryPlan(
  read: () => Promise<unknown>,
  {
    latestStateTables,
    scanning,
    reaches,
  }: { latestStateTables: string[]; scanning: string[]; reaches: string[] }
) {
  const statements = await statementsRunBy(read)

  expect(statements, 'statements the read ran').not.toHaveLength(0)

  for (const { statistics, plans } of await plansOf(statements)) {
    const message = `statistics ${statistics}`

    expect(
      plans.flatMap((plan) => wholeTableReadsBeyond(plan, scanning)),
      message
    ).toEqual([])
    expect(
      plans.flatMap((plan) => lookupsThatSort(plan, latestStateTables)),
      message
    ).toEqual([])

    for (const step of reaches) {
      expect(
        plans.flat().map(({ detail }) => detail),
        message
      ).toContain(step)
    }
  }
}

export { expectEveryPlan }
