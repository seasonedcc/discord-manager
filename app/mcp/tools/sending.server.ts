import { REST, type RESTPostAPIChannelMessageResult, Routes } from 'discord.js'
import type { MessageSendTransport } from '~/business/sending.common'
import {
  readMessageSendStatusSchema,
  sendMessageSchema,
} from '~/business/sending.common'
import { readMessageSendStatus, sendMessage } from '~/business/sending.server'
import { env } from '~/env.server'
import type { McpTool } from '~/mcp/tool'

const postThroughDiscord: MessageSendTransport = async ({
  content,
  discordChannelId,
  replyToDiscordMessageId,
}) => {
  const rest = new REST({ api: env().discordApiBaseUrl }).setToken(
    env().discordBotToken
  )

  const message = (await rest.post(Routes.channelMessages(discordChannelId), {
    body: {
      content,
      message_reference: replyToDiscordMessageId
        ? { message_id: replyToDiscordMessageId }
        : undefined,
    },
  })) as RESTPostAPIChannelMessageResult

  return { discordMessageId: message.id }
}

const sendingTools: McpTool[] = [
  {
    name: 'messages_send',
    description:
      'Post a message to a channel as your bot, optionally as a reply to a message the bot has ingested.',
    inputSchema: sendMessageSchema,
    wraps: ['sending.sendMessage'],
    execute: (input, context) =>
      sendMessage(postThroughDiscord)(input, context),
  },
  {
    name: 'messages_send_status',
    description:
      'Read where a message you sent ended up — delivered, skipped, failed, or still on its way — and what to do next.',
    inputSchema: readMessageSendStatusSchema,
    wraps: ['sending.readMessageSendStatus'],
    execute: (input, context) => readMessageSendStatus(input, context),
  },
]

export { sendingTools }
