import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { type CompiledQuery, sql } from 'kysely'
import { env } from '~/framework/env.server'
import { db, expect, vi } from './prelude'

type PlanStep = { id: number; parent: number; detail: string; table?: string }

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

function planOf(store: Database.Database, statement: CompiledQuery) {
  const tablesByIndex = new Map(
    (
      store
        .prepare(
          `select name, tbl_name as "table" from sqlite_schema where type = 'index'`
        )
        .all() as { name: string; table: string }[]
    ).map(({ name, table }) => [name, table])
  )
  const steps = store
    .prepare(`explain query plan ${statement.sql}`)
    .all(...statement.parameters) as PlanStep[]

  return steps.map((step) => {
    const tableRead =
      /^(?:SEARCH|SCAN) (\S+)(?:.* USING (?:COVERING )?INDEX (\S+))?/.exec(
        step.detail
      )

    return tableRead
      ? { ...step, table: tablesByIndex.get(tableRead[2]) ?? tableRead[1] }
      : step
  })
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
        plans: statements.map((statement) =>
          planOf(withoutStatistics, statement)
        ),
      },
      {
        statistics: 'gathered',
        plans: statements.map((statement) => planOf(withStatistics, statement)),
      },
    ]
  } finally {
    withoutStatistics.close()
    withStatistics.close()
  }
}

function wholeTableReadsBeyond(plan: PlanStep[], allowedScans: string[]) {
  const derivedTables = plan.flatMap(
    ({ detail }) =>
      /^(?:CO-ROUTINE|MATERIALIZE) (\S+)/.exec(detail)?.slice(1) ?? []
  )

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
  const subtreeOf = (root: PlanStep): PlanStep[] => [
    root,
    ...plan.filter(({ parent }) => parent === root.id).flatMap(subtreeOf),
  ]

  return plan
    .filter(({ detail }) =>
      /^(?:CORRELATED )?(?:SCALAR|LIST) SUBQUERY/.test(detail)
    )
    .map(subtreeOf)
    .filter(
      (lookup) =>
        lookup.some(({ detail }) => detail.startsWith('USE TEMP B-TREE')) &&
        lookup.some(
          ({ table }) =>
            table !== undefined && latestStateTables.includes(table)
        )
    )
    .map((lookup) => lookup.map(({ detail }) => detail))
}

async function expectEveryPlan(
  read: () => Promise<unknown>,
  {
    latestStateTables,
    scanning,
    reaches,
  }: { latestStateTables: string[]; scanning: string[]; reaches: string[] }
) {
  for (const { statistics, plans } of await plansOf(read)) {
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
