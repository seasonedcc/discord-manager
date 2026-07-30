import { existsSync } from 'node:fs'
import { Client, GatewayIntentBits, Partials } from 'discord.js'
import type { BackfilledMessage } from '~/business/ingestion.common'
import { jobs } from '~/business/jobs.server'
import { env, requireEnvironment } from '~/env.server'
import { makeSchedulerRunner } from '~/framework/scheduler.server'
import { registerGatewayListeners } from './gateway.server'

if (existsSync('.env')) process.loadEnvFile()

requireEnvironment()

function makeChannelHistoryFetcher(client: Client) {
  return async ({
    afterDiscordMessageId,
    discordChannelId,
    limit,
  }: {
    afterDiscordMessageId: string
    discordChannelId: string
    limit: number
  }): Promise<BackfilledMessage[]> => {
    const channel = await client.channels.fetch(discordChannelId)

    if (!channel?.isTextBased()) return []

    const messages = await channel.messages.fetch({
      after: afterDiscordMessageId,
      limit,
    })

    return messages.map((message) => ({
      author: {
        discordUserId: message.author.id,
        displayName: message.author.displayName,
        username: message.author.username,
      },
      content: message.content,
      discordCreatedAt: message.createdAt.toISOString(),
      discordMessageId: message.id,
      mentionedDiscordUserIds: [...message.mentions.users.keys()],
    }))
  }
}

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

async function shutDown() {
  await scheduler.stop()
  await client.destroy()
  process.exit(0)
}

process.on('SIGINT', shutDown)
process.on('SIGTERM', shutDown)

await client.login(env().discordBotToken)
