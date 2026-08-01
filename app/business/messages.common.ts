import { z } from 'zod'

const observedEmbedSchema = z.object({
  authorName: z.string().optional(),
  description: z.string().optional(),
  fields: z.array(z.object({ name: z.string(), value: z.string() })).optional(),
  footerText: z.string().optional(),
  imageUrl: z.string().optional(),
  thumbnailUrl: z.string().optional(),
  timestamp: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
})

const observedAttachmentSchema = z.object({
  filename: z.string().min(1),
  size: z.number().int().nonnegative(),
  url: z.string().min(1),
})

const observedEmojiSchema = z
  .object({
    animated: z.boolean().default(false),
    id: z.string().min(1).optional(),
    name: z.string(),
  })
  .refine(({ id, name }) => id !== undefined || name.length > 0, {
    error: 'An emoji is identified by its name, its id, or both',
  })

const messageEmbedsSchema = z.array(z.string())

const messageAttachmentsSchema = z.array(observedAttachmentSchema)

const messageReactionsSchema = z.array(
  z.object({
    count: z.number().int().positive(),
    emoji: z.string().min(1),
    ownerReacted: z.coerce.boolean(),
  })
)

type ObservedEmbed = z.infer<typeof observedEmbedSchema>

type ObservedAttachment = z.infer<typeof observedAttachmentSchema>

type ObservedReaction = {
  count: number
  emoji: string
  reactorDiscordUserIds: string[]
}

type MessageFetchFailureKind = 'gone' | 'rejected' | 'unreachable'

type MessageFetchSkipReason = 'message_deleted'

type MessageFetchOutcome =
  | { status: 'retrieved' }
  | { status: 'failed'; kind: MessageFetchFailureKind }
  | { status: 'skipped'; reason: MessageFetchSkipReason }

type MessageFetchGuidance = {
  summary: string
  nextAction: string
}

type MessageFetchTransport = (request: {
  discordChannelId: string
  discordMessageId: string
}) => Promise<{
  attachments: ObservedAttachment[]
  content: string
  embeds: ObservedEmbed[]
  reactions?: ObservedReaction[]
}>

class MessageFetchGoneError extends Error {}

class MessageFetchRejectedError extends Error {}

const messageFetchRetrievalCopy = {
  summary: 'This is what Discord has for the message right now.',
  nextAction:
    'Read it to the owner — any attachment link in it is freshly signed and stops working after about a day.',
} satisfies MessageFetchGuidance

const messageFetchFailureCopy = {
  gone: {
    summary:
      'Discord no longer has this message — it was deleted there, and the store has now recorded that.',
    nextAction:
      'Tell the owner it is gone — it stops coming back in catch-ups, mentions and bookmarks from here on. Read `channelId` back through messages_catch_up to see what stands in that channel now.',
  },
  rejected: {
    summary: 'Discord refused to hand this message over, so nothing was read.',
    nextAction:
      'Open `jumpUrl` to find the channel, give the bot View Channel and Read Message History there, check DISCORD_BOT_TOKEN, then fetch it again.',
  },
  unreachable: {
    summary: 'We could not reach Discord, so nothing was read.',
    nextAction:
      'Check this machine can reach Discord, then fetch it again — reading a message changes nothing there, so another attempt is safe.',
  },
} satisfies Record<MessageFetchFailureKind, MessageFetchGuidance>

const messageFetchSkipCopy = {
  message_deleted: {
    summary: 'That message was deleted in Discord, so nothing was fetched.',
    nextAction:
      'Pick another message — read `channelId` back through messages_catch_up to see what stands in that channel now.',
  },
} satisfies Record<MessageFetchSkipReason, MessageFetchGuidance>

function messageFetchGuidance(outcome: MessageFetchOutcome) {
  switch (outcome.status) {
    case 'failed':
      return messageFetchFailureCopy[outcome.kind]
    case 'skipped':
      return messageFetchSkipCopy[outcome.reason]
    default:
      return messageFetchRetrievalCopy
  }
}

const fetchMessageSchema = z.object({
  messageId: z
    .string()
    .min(1)
    .describe(
      'The `messageId` from messages_catch_up, mentions_list or bookmarks_list — not the Discord message snowflake.'
    ),
})
type ObservedEmoji = z.infer<typeof observedEmojiSchema>

function renderEmbed({
  authorName,
  description,
  fields,
  footerText,
  imageUrl,
  thumbnailUrl,
  timestamp,
  title,
  url,
}: ObservedEmbed) {
  const parts = [
    authorName,
    title && url ? `${title} (${url})` : title || url,
    description,
    ...(fields ?? []).map(({ name, value }) => `${name}: ${value}`),
    imageUrl,
    thumbnailUrl,
    footerText,
    timestamp,
  ]

  return parts.flatMap((part) => (part?.trim() ? [part] : [])).join('\n')
}

function renderEmoji({ animated, id, name }: ObservedEmoji) {
  if (!id) return name

  return animated ? `a:${name}:${id}` : `${name}:${id}`
}

export {
  MessageFetchGoneError,
  MessageFetchRejectedError,
  fetchMessageSchema,
  messageAttachmentsSchema,
  messageEmbedsSchema,
  messageFetchFailureCopy,
  messageFetchGuidance,
  messageFetchRetrievalCopy,
  messageFetchSkipCopy,
  messageReactionsSchema,
  observedAttachmentSchema,
  observedEmbedSchema,
  observedEmojiSchema,
  renderEmbed,
  renderEmoji,
}
export type {
  MessageFetchFailureKind,
  MessageFetchGuidance,
  MessageFetchSkipReason,
  MessageFetchTransport,
  ObservedAttachment,
  ObservedEmbed,
  ObservedEmoji,
  ObservedReaction,
}
