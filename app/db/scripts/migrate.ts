import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { migrateDbToLatest } from '~/framework/db.server'
import { db } from '../db.server'

if (existsSync('.env')) process.loadEnvFile()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const migrationsFolder = path.join(__dirname, '..', 'migrations')

await migrateDbToLatest(db, migrationsFolder)
