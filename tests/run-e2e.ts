import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { db } from '~/db/db.server'
import { reportToolCoverage } from './coverage/gate'
import {
  closeOpenSessions,
  repositoryRoot,
  serverEnvironment,
} from './mcp-client'
import { seedTheStore } from './seed'
import { type Spec, takeRegisteredSpecs } from './spec'

const specsFolder = path.join(repositoryRoot, 'tests')
const databasePath = serverEnvironment.DATABASE_PATH

const requestedRepeats = Number(
  process.argv.find((argument) => argument.startsWith('--repeat='))?.slice(9) ??
    1
)
const filters = process.argv
  .slice(2)
  .filter((argument) => !argument.startsWith('--'))

function freshStore() {
  if (!path.basename(databasePath).includes('e2e')) {
    throw new Error(
      `The E2E database file name must contain "e2e" so a run can never wipe a real store. Got "${databasePath}".`
    )
  }

  mkdirSync(path.dirname(databasePath), { recursive: true })

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true })
  }

  const migration = spawnSync(
    'pnpm',
    ['exec', 'tsx', './app/db/scripts/migrate.ts'],
    { cwd: repositoryRoot, env: process.env, stdio: 'inherit' }
  )

  if (migration.status !== 0) {
    throw new Error('Migrating the fresh E2E store failed')
  }
}

const loadedSpecs = new Map<string, Spec>()

async function loadSpec(fileName: string) {
  const alreadyLoaded = loadedSpecs.get(fileName)

  if (alreadyLoaded) return alreadyLoaded

  await import(pathToFileURL(path.join(specsFolder, fileName)).href)

  const registered = takeRegisteredSpecs()

  if (registered.length !== 1) {
    throw new Error(
      `${fileName} must call test() exactly once — it called it ${registered.length} times`
    )
  }

  const [spec] = registered

  loadedSpecs.set(fileName, spec)

  return spec
}

Object.assign(process.env, serverEnvironment)

freshStore()

await seedTheStore()

const specFileNames = readdirSync(specsFolder)
  .filter((fileName) => fileName.endsWith('.spec.ts'))
  .filter((fileName) => filters.every((filter) => fileName.includes(filter)))
  .sort()

if (specFileNames.length === 0) {
  throw new Error(`No spec matched ${filters.join(' ')}`)
}

let failures = 0

for (let attempt = 1; attempt <= requestedRepeats; attempt += 1) {
  if (requestedRepeats > 1) console.log(`\nAttempt ${attempt}`)

  for (const fileName of specFileNames) {
    const spec = await loadSpec(fileName)

    try {
      await spec.run()
      console.log(`  ok    ${spec.name}`)
    } catch (error) {
      failures += 1
      console.error(`  FAIL  ${spec.name}`)
      console.error(error)
    } finally {
      await closeOpenSessions()
    }
  }
}

console.log(
  `\n${specFileNames.length * requestedRepeats} specs, ${failures} failed`
)

const coverageFailures = reportToolCoverage({ enforcing: filters.length === 0 })

await db().destroy()

process.exitCode = failures + coverageFailures > 0 ? 1 : 0
