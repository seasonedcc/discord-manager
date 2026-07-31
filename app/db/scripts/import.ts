import { existsSync } from 'node:fs'
import { importDatabase } from '~/framework/db-backup.server'
import { env } from '~/framework/env.server'

if (existsSync('.env')) process.loadEnvFile()

const dumpDirectory = process.argv[2] ?? './data/dump'

function count(amount: number) {
  return amount.toLocaleString('en-US')
}

try {
  const restore = importDatabase({
    databasePath: env().databasePath,
    dumpDirectory,
  })
  const widestCount = Math.max(
    ...restore.tables.map((table) => count(table.rows).length)
  )

  console.log(
    `Restored ${env().databasePath} from ${dumpDirectory}. SQLite's integrity and foreign key checks both came back clean.`
  )

  for (const table of restore.tables) {
    console.log(`  ${count(table.rows).padStart(widestCount)}  ${table.name}`)
  }

  console.log(
    `${count(restore.rows)} rows across ${count(restore.tables.length)} tables.`
  )
  console.log(
    'Now run pnpm run db:migrate to apply any migrations newer than this dump.'
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
