import { existsSync } from 'node:fs'
import { requireEnvironment } from '~/env.server'
import { startMcpServer } from './server.server'

if (existsSync('.env')) process.loadEnvFile()

requireEnvironment()

await startMcpServer()
