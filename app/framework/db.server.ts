import type {
  FileMigrationProviderProps,
  Migration,
  MigrationProvider,
  MigrationResultSet,
} from 'kysely'

import { randomBytes } from 'node:crypto'
import fs, { promises } from 'node:fs'
import * as path from 'node:path'
import Database from 'better-sqlite3'
import { CamelCasePlugin, Kysely, Migrator, SqliteDialect } from 'kysely'
import { env } from './env.server'
import { getOrSetGlobal } from './globals'

const plugins = [new CamelCasePlugin()]

function openDatabase(databasePath: string) {
  const resolvedPath = path.resolve(databasePath)

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true })

  const database = new Database(resolvedPath)

  database.pragma('journal_mode = WAL')
  database.pragma('foreign_keys = ON')
  database.pragma('busy_timeout = 5000')

  return database
}

function makeDb<DB>(databasePath: () => string = () => env().databasePath) {
  return () =>
    getOrSetGlobal(
      'db',
      () =>
        new Kysely<DB>({
          dialect: new SqliteDialect({
            database: openDatabase(databasePath()),
          }),
          plugins,
        })
    )
}

// Event rows tie on createdAt at millisecond resolution, and the id is their
// tie-break, so ids must sort in issue order even within one millisecond.
let lastIssuedInstant = -1
let sameInstantSequence = 0

function newId() {
  const now = Math.max(Date.now(), lastIssuedInstant)

  if (now > lastIssuedInstant) {
    lastIssuedInstant = now
    sameInstantSequence = 0
  } else if (sameInstantSequence === 0xfff) {
    lastIssuedInstant += 1
    sameInstantSequence = 0
  } else {
    sameInstantSequence += 1
  }

  const instant = lastIssuedInstant.toString(16).padStart(12, '0')
  const sequence = sameInstantSequence.toString(16).padStart(3, '0')
  const entropy = randomBytes(8).toString('hex')
  const variant = ((Number.parseInt(entropy[0], 16) & 0x3) | 0x8).toString(16)

  return `${instant.slice(0, 8)}-${instant.slice(8)}-7${sequence}-${variant}${entropy.slice(1, 4)}-${entropy.slice(4)}`
}

const MIGRATION_TEMPLATE = `import type { Kysely } from 'kysely'
import { sql } from 'kysely'

export async function up(db: Kysely<any>): Promise<void> {
}

export async function down(db: Kysely<any>): Promise<void> {
}
`

async function createDbMigration(
  migrationsFolder: string,
  migrationName: string
) {
  if (!migrationName) {
    console.error(
      'You must name this migration by running "pnpm run db:migration the name for your migration"'
    )
    process.exit(1)
  }

  const dateStr = new Date().toISOString().replace(/[-:]/g, '').split('.')[0]
  const fileName = `${migrationsFolder}/${dateStr}-${migrationName}.ts`

  fs.mkdirSync(migrationsFolder, { recursive: true })
  fs.writeFileSync(fileName, MIGRATION_TEMPLATE, 'utf8')

  console.log('Created Migration:', fileName)
}

class FileMigrationProvider implements MigrationProvider {
  readonly #props: FileMigrationProviderProps

  constructor(props: FileMigrationProviderProps) {
    this.#props = props
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    const migrations: Record<string, Migration> = {}
    const files = await this.#props.fs.readdir(this.#props.migrationFolder)

    for (const fileName of files) {
      if (
        fileName.endsWith('.js') ||
        (fileName.endsWith('.ts') && !fileName.endsWith('.d.ts')) ||
        fileName.endsWith('.mjs') ||
        (fileName.endsWith('.mts') && !fileName.endsWith('.d.mts'))
      ) {
        const migration = await import(
          /* @vite-ignore */
          this.#props.path.join(this.#props.migrationFolder, fileName)
        )
        const migrationKey = fileName.substring(0, fileName.lastIndexOf('.'))

        if (isMigration(migration?.default)) {
          migrations[migrationKey] = migration.default
        } else if (isMigration(migration)) {
          migrations[migrationKey] = migration
        }
      }
    }

    return migrations
  }
}

function isFunction(obj: unknown): obj is (...args: any[]) => any {
  return typeof obj === 'function'
}

function isObject(obj: unknown): obj is Record<string, unknown> {
  return typeof obj === 'object' && obj !== null
}

function isMigration(obj: unknown): obj is Migration {
  return isObject(obj) && isFunction(obj.up)
}

function createMigrator(db: () => Kysely<any>, migrationFolder: string) {
  return new Migrator({
    allowUnorderedMigrations: true,
    db: db(),
    provider: new FileMigrationProvider({
      fs: promises,
      path,
      migrationFolder,
    }),
  })
}

async function logMigrationResults(resultSet: Promise<MigrationResultSet>) {
  const { error, results } = await resultSet

  results?.forEach((it) => {
    if (it.status === 'Success') {
      console.log(`Migration "${it.migrationName}" was executed successfully`)
    } else if (it.status === 'Error') {
      console.error(`Failed to execute migration "${it.migrationName}"`)
    }
  })

  if (error) {
    console.error('Failed to migrate')
    console.error(error)
    process.exit(1)
  }
}

async function migrateDbToLatest(
  db: () => Kysely<any>,
  migrationFolder: string
) {
  const migrator = createMigrator(db, migrationFolder)
  await logMigrationResults(migrator.migrateToLatest())
  await db().destroy()
}

async function migrateDbDown(db: () => Kysely<any>, migrationFolder: string) {
  const migrator = createMigrator(db, migrationFolder)
  await logMigrationResults(migrator.migrateDown())
  await db().destroy()
}

class RecordNotFoundError extends Error {
  constructor() {
    super('Record not found')
  }
}

export {
  RecordNotFoundError,
  createDbMigration,
  makeDb,
  migrateDbDown,
  migrateDbToLatest,
  newId,
}
