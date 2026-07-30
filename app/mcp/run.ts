import { existsSync } from 'node:fs'
import { startMcpServer } from './server.server'

if (existsSync('.env')) process.loadEnvFile()

await startMcpServer()
