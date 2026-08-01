import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeDb, migrateDbToLatest } from '~/framework/db.server'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..'
)
const migrationsFolder = path.join(repositoryRoot, 'app', 'db', 'migrations')
const throwawayStorePath = path.join(
  repositoryRoot,
  'tests',
  '.artifacts',
  'type-generation.db'
)
const outFile =
  process.argv[2] ?? path.join(repositoryRoot, 'app', 'db', 'types.d.ts')

if (!path.basename(throwawayStorePath).includes('type-generation')) {
  throw new Error(
    `The type generation database file name must contain "type-generation" so a run can never wipe a real store. Got "${throwawayStorePath}".`
  )
}

function removeThrowawayStore() {
  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${throwawayStorePath}${suffix}`, { force: true })
  }
}

removeThrowawayStore()

console.log(
  'Generating types from a throwaway store built by app/db/migrations'
)

await migrateDbToLatest(
  makeDb(() => throwawayStorePath),
  migrationsFolder
)

const codegenBin = createRequire(import.meta.url).resolve(
  'kysely-codegen/dist/cli/bin.js'
)

const { status } = spawnSync(
  process.execPath,
  [
    codegenBin,
    '--dialect',
    'sqlite',
    '--url',
    throwawayStorePath,
    '--out-file',
    outFile,
    '--camel-case',
  ],
  { stdio: 'inherit' }
)

removeThrowawayStore()

process.exit(status ?? 1)
