import { z } from 'zod'

// A send is a single REST call with no scheduled retry, so nothing can still be
// working on a request that has gone this long without recording an outcome.
const messageSendStallThresholdMinutes = 15

type MessageSendSkipReason =
  | 'channel_not_found'
  | 'channel_not_in_guild'
  | 'empty_content'

type MessageSendStatus =
  | 'delivered'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'stalled'

type MessageSendGuidance = {
  summary: string
  nextAction: string
}

type MessageSendTransport = (request: {
  content: string
  discordChannelId: string
  replyToDiscordMessageId: string | null
}) => Promise<{ discordMessageId: string }>

const messageSendSkipCopy = {
  channel_not_found: {
    summary: 'That channel is gone from the bot, so nothing was posted.',
    nextAction:
      'List the channels again and pick one the bot can still see, then send.',
  },
  channel_not_in_guild: {
    summary:
      'That channel belongs to a different Discord server than this deployment manages.',
    nextAction:
      'Pick a channel from the managed server, or point DISCORD_GUILD_ID at the server you meant and restart the bot.',
  },
  empty_content: {
    summary: 'The message had no visible text, so nothing was posted.',
    nextAction: 'Write the message text, then send it again.',
  },
} satisfies Record<MessageSendSkipReason, MessageSendGuidance>

const messageSendStatusCopy = {
  delivered: {
    summary: 'The message is live in the channel.',
    nextAction: 'Open the channel in Discord to follow the conversation.',
  },
  failed: {
    summary: 'Discord rejected the message, so it was never posted.',
    nextAction:
      'Give the bot Send Messages permission in that channel, then send it again.',
  },
  pending: {
    summary: 'The message is on its way to Discord.',
    nextAction: 'Read this send again in a moment to see where it landed.',
  },
  skipped: {
    summary: 'The message was not posted.',
    nextAction: 'Send it again to a channel the bot can post in.',
  },
  stalled: {
    summary: 'This send stopped without ever reaching Discord.',
    nextAction: 'Send the message again.',
  },
} satisfies Record<MessageSendStatus, MessageSendGuidance>

const readMessageSendStatusSchema = z.object({
  requestId: z.string().min(1),
})

const sendMessageSchema = z.object({
  channelId: z.string().min(1),
  content: z.string().min(1).max(2000),
  replyToMessageId: z.string().min(1).optional(),
})

export {
  messageSendSkipCopy,
  messageSendStallThresholdMinutes,
  messageSendStatusCopy,
  readMessageSendStatusSchema,
  sendMessageSchema,
}

export type {
  MessageSendGuidance,
  MessageSendSkipReason,
  MessageSendStatus,
  MessageSendTransport,
}
