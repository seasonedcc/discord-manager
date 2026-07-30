import {
  DiscordAPIError,
  REST,
  type RESTPostAPIChannelMessageResult,
  Routes,
} from 'discord.js'
import type { MessageSendTransport } from '~/business/sending.common'
import {
  TransportRejectedError,
  readMessageSendStatusSchema,
  sendMessageSchema,
} from '~/business/sending.common'
import { readMessageSendStatus, sendMessage } from '~/business/sending.server'
import { env } from '~/env.server'
import type { McpTool } from '~/mcp/tool'

let discordRest: REST | undefined

function restClient() {
  discordRest ??= new REST({ api: env().discordApiBaseUrl }).setToken(
    env().discordBotToken
  )

  return discordRest
}

const postThroughDiscord: MessageSendTransport = async ({
  content,
  discordChannelId,
  replyToDiscordMessageId,
}) => {
  try {
    const message = (await restClient().post(
      Routes.channelMessages(discordChannelId),
      {
        body: {
          content,
          message_reference: replyToDiscordMessageId
            ? { message_id: replyToDiscordMessageId }
            : undefined,
        },
      }
    )) as RESTPostAPIChannelMessageResult

    return { discordMessageId: message.id }
  } catch (error) {
    if (error instanceof DiscordAPIError) {
      throw new TransportRejectedError(error.message)
    }

    throw error
  }
}

const sendingTools: McpTool[] = [
  {
    name: 'messages_send',
    description:
      'Post a message to a channel as your bot, optionally as a reply to a message the bot has ingested. Answers with `send`, whose `status` must be read: delivered means it is live in the channel, skipped means it never went out and `reason` says why, failed means Discord refused it or could not be reached. To make another attempt at an earlier send, pass its `requestId` as `retryOfRequestId` — the send is then refused outright unless that attempt provably never reached the channel, so a message can never be posted twice this way. Read `summary` and `nextAction` to the owner rather than retrying blindly.',
    inputSchema: sendMessageSchema,
    wraps: ['sending.sendMessage'],
    execute: (input, context) =>
      sendMessage(postThroughDiscord)(input, context),
  },
  {
    name: 'messages_send_status',
    description:
      'Read where a message you sent ended up — delivered, skipped, failed, pending while it is still on its way, or stalled when nothing was ever recorded — and what to do next. `canRetry` says whether another attempt at it would be accepted, `retryOfRequestId` names the send this one was an attempt at, and `retries` lists the attempts made at this one with where each of them stands.',
    inputSchema: readMessageSendStatusSchema,
    wraps: ['sending.readMessageSendStatus'],
    execute: (input, context) => readMessageSendStatus(input, context),
  },
]

export { sendingTools }
