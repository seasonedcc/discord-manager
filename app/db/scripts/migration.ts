import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDbMigration } from '~/framework/db.server'

if (existsSync('.env')) process.loadEnvFile()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const migrationsFolder = path.join(__dirname, '..', 'migrations')

const [_command, _file, ...names] = process.argv
const migrationName = names
  .join(' ')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')

await createDbMigration(migrationsFolder, migrationName)
