import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { env } from '~/framework/env.server'

if (existsSync('.env')) process.loadEnvFile()

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
    env().databasePath,
    '--out-file',
    './app/db/types.d.ts',
    '--camel-case',
  ],
  { stdio: 'inherit' }
)

process.exit(status ?? 1)
