import { randomUUID } from 'node:crypto'
import { copyFileSync } from 'node:fs'
import * as path from 'node:path'
import { env } from '~/framework/env.server'

const migratedStorePath = env().databasePath
const fileStorePath = path.join(
  path.dirname(migratedStorePath),
  `${randomUUID()}.db`
)

copyFileSync(migratedStorePath, fileStorePath)

process.env.DATABASE_PATH = fileStorePath
