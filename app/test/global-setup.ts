import { rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '~/db/db.server'
import { migrateDbToLatest } from '~/framework/db.server'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const migrationsFolder = path.join(__dirname, '..', 'db', 'migrations')
const unitDatabasePath = path.join('tests', '.artifacts', 'unit.db')

async function setup() {
  if (!path.basename(unitDatabasePath).includes('unit')) {
    throw new Error(
      `The unit test database file name must contain "unit" so tests can never run against a real store. Got "${unitDatabasePath}".`
    )
  }

  process.env.DATABASE_PATH = unitDatabasePath
  process.env.DISCORD_BOT_TOKEN ??= 'unit-test-bot-token'
  process.env.DISCORD_OWNER_USER_ID ??= 'unit-test-owner-user-id'
  process.env.DISCORD_GUILD_ID ??= 'unit-test-guild-id'

  rmSync(unitDatabasePath, { force: true })
  rmSync(`${unitDatabasePath}-wal`, { force: true })
  rmSync(`${unitDatabasePath}-shm`, { force: true })

  await migrateDbToLatest(db, migrationsFolder)
}

export { setup }
