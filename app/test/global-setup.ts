import { rmSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { db } from '~/db/db.server'
import { migrateDbToLatest } from '~/framework/db.server'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const migrationsFolder = path.join(__dirname, '..', 'db', 'migrations')
const unitStoresFolder = path.join('tests', '.artifacts', 'unit-stores')

async function setup() {
  if (!path.basename(unitStoresFolder).includes('unit')) {
    throw new Error(
      `The unit test stores folder name must contain "unit" so tests can never run against, or wipe, a real store. Got "${unitStoresFolder}".`
    )
  }

  process.env.DATABASE_PATH = path.join(unitStoresFolder, 'migrated.db')
  process.env.DISCORD_BOT_TOKEN ??= 'unit-test-bot-token'
  process.env.DISCORD_OWNER_USER_ID ??= 'unit-test-owner-user-id'
  process.env.DISCORD_GUILD_ID ??= 'unit-test-guild-id'

  rmSync(unitStoresFolder, { force: true, recursive: true })

  await migrateDbToLatest(db, migrationsFolder)
}

export { setup }
