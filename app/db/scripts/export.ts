import { existsSync } from 'node:fs'
import { exportDatabase } from '~/framework/db-backup.server'
import { env } from '~/framework/env.server'

if (existsSync('.env')) process.loadEnvFile()

const dumpDirectory = process.argv[2] ?? './data/dump'

function humanBytes(bytes: number) {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let size = bytes
  let unit = 0

  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }

  return `${unit === 0 ? size : size.toFixed(1)} ${units[unit]}`
}

function count(amount: number) {
  return amount.toLocaleString('en-US')
}

try {
  const dump = exportDatabase({
    databasePath: env().databasePath,
    dumpDirectory,
  })

  console.log(
    `Exported ${count(dump.rows)} rows from ${count(dump.tables)} tables into ${count(dump.files)} chunk files at ${dumpDirectory} — largest chunk ${humanBytes(dump.largestChunkBytes)}.`
  )
  console.log(
    `Commit ${dumpDirectory}: every chunk but the last of each table is byte-identical to the previous export, so git only stores what you appended.`
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
