import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerContext } from '~/business/auth.server'
import { db } from '~/db/db.server'
import { registeredTools } from '~/mcp/registry.server'
import {
  declaredUnseedable,
  seedCoverageProblems,
  seedDemonstrations,
} from './demonstrations'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
)
const databasePath = path.join(
  repositoryRoot,
  'tests',
  '.artifacts',
  'seed-coverage.db'
)

const seedEnvironment = {
  DATABASE_PATH: databasePath,
  DISCORD_BOT_TOKEN: 'seed-coverage-bot-token',
  DISCORD_GUILD_ID: '1500000000000000001',
  DISCORD_OWNER_USER_ID: '1500000000000000002',
}

function runThroughTsx(script: string, whatFailed: string) {
  const finished = spawnSync('pnpm', ['exec', 'tsx', script], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: 'inherit',
  })

  if (finished.status !== 0) throw new Error(whatFailed)
}

function freshStore() {
  if (!path.basename(databasePath).includes('seed-coverage')) {
    throw new Error(
      `The dev-seed coverage database file name must contain "seed-coverage" so a run can never wipe a real store. Got "${databasePath}".`
    )
  }

  mkdirSync(path.dirname(databasePath), { recursive: true })

  for (const suffix of ['', '-wal', '-shm']) {
    rmSync(`${databasePath}${suffix}`, { force: true })
  }
}

Object.assign(process.env, seedEnvironment)

freshStore()

runThroughTsx(
  './app/db/scripts/migrate.ts',
  'Migrating the throwaway dev-seed store failed'
)
runThroughTsx(
  './app/db/dev-seed/seed.ts',
  'The dev seed refused to build demo state on a freshly migrated store'
)

const context = ownerContext()
const registeredNames = registeredTools.map(({ name }) => name)
const problems = seedCoverageProblems(registeredNames)
const demonstrations = Object.entries(seedDemonstrations)

let demonstrated = 0
let failures = problems.length

console.log('\nDev-seed tool coverage')

for (const [name, { demonstrates, prove }] of demonstrations) {
  try {
    const evidence = await prove(context)

    demonstrated += 1
    console.log(`  demonstrated  ${name} — ${evidence}`)
  } catch (error) {
    failures += 1
    console.error(`  MISSING       ${name} — ${demonstrates}`)
    console.error(
      `                ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

for (const [name, reason] of Object.entries(declaredUnseedable)) {
  console.log(`  unseedable    ${name} — ${reason}`)
}

console.log(
  `${demonstrated} of ${registeredNames.length} registered tools answered with demo state, ${Object.keys(declaredUnseedable).length} declared unseedable.`
)

for (const problem of problems) console.error(`  ${problem}`)

await db().destroy()

process.exitCode = failures > 0 ? 1 : 0
