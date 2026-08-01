import { existsSync } from 'node:fs'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import { jobs } from '~/business/jobs.server'
import { env, requireEnvironment } from '~/env.server'
import { makeSchedulerRunner } from '~/framework/scheduler.server'
import {
  makeChannelHistoryFetcher,
  registerGatewayListeners,
  startGatewayHeartbeat,
} from './gateway.server'

if (existsSync('.env')) process.loadEnvFile()

requireEnvironment()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction],
})

const scheduler = makeSchedulerRunner(jobs)

registerGatewayListeners(client, {
  fetchChannelHistory: makeChannelHistoryFetcher(client),
})

scheduler.start()

const stopGatewayHeartbeat = startGatewayHeartbeat()

async function shutDown() {
  stopGatewayHeartbeat()
  await scheduler.stop()
  await client.destroy()
  process.exit(0)
}

process.on('SIGINT', shutDown)
process.on('SIGTERM', shutDown)

await client.login(env().discordBotToken)
