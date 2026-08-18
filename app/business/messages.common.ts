import { InputError } from 'composable-functions'
import { z } from 'zod'

const discordMessageLinkPattern =
  /^https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)\/([^/]+)$/
const discordSnowflakePattern = /^\d{17,20}$/

function messageLinkTarget({
  guildId,
  messageLink,
}: {
  guildId: string
  messageLink: string
}) {
  const link = messageLink.match(discordMessageLinkPattern)

  if (!link) {
    throw new InputError(
      'That is not a Discord message link. Right-click the message in Discord, choose Copy Message Link, and pass that — it looks like https://discord.com/channels/<server>/<channel>/<message>.',
      ['messageLink']
    )
  }

  const [, discordGuildId, discordChannelId, discordMessageId] = link

  if (
    ![discordGuildId, discordChannelId, discordMessageId].every((id) =>
      discordSnowflakePattern.test(id)
    )
  ) {
    throw new InputError(
      'That message link carries something other than Discord ids. Copy it again from Discord without editing the numbers.',
      ['messageLink']
    )
  }

  if (discordGuildId !== guildId) {
    throw new InputError(
      'That link points at a different Discord server than this deployment manages. Pick a message from the server this deployment manages.',
      ['messageLink']
    )
  }

  return { discordChannelId, discordGuildId, discordMessageId }
}

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

const observedReplyReferenceSchema = z.object({
  discordChannelId: z.string().min(1),
  discordGuildId: z.string().min(1),
  discordMessageId: z.string().min(1),
})

const storedReplyReferenceSchema = observedReplyReferenceSchema.extend({
  messageId: z.string().min(1).nullable(),
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

type ObservedReplyReference = z.infer<typeof observedReplyReferenceSchema>

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
  repliedTo?: ObservedReplyReference
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
      'Tell the owner it is gone — it stops coming back in catch-ups and mentions from here on, and a bookmark on it stays listed with `deletedUpstream` set until they resolve it with bookmarks_resolve. Read `channelId` back through messages_catch_up to see what stands in that channel now.',
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

const messageIdMessage =
  'Pass a `messageId` from messages_catch_up, mentions_list or bookmarks_list, not the Discord message snowflake'

const messageLinkMessage =
  'Paste the link Discord copies with Copy Message Link, such as https://discord.com/channels/<server>/<channel>/<message>'

const oneLocatorMessage =
  'Pass either `messageId` from messages_catch_up, mentions_list or bookmarks_list, or `messageLink` copied from Discord with Copy Message Link — one of the two, never both'

const fetchMessageSchema = z.object({
  messageId: z
    .string({ error: messageIdMessage })
    .min(1, messageIdMessage)
    .optional()
    .describe(
      'The `messageId` from messages_catch_up, mentions_list or bookmarks_list — not the Discord message snowflake. Leave it out when you pass `messageLink`.'
    ),
  messageLink: z
    .string({ error: messageLinkMessage })
    .min(1, messageLinkMessage)
    .optional()
    .describe(
      'A Discord message link, from Copy Message Link in Discord: https://discord.com/channels/<server>/<channel>/<message>. Links from canary.discord.com, ptb.discord.com and discordapp.com work too. Pass a link the owner gave you straight through — no lookup first — as long as the bot has already ingested the message it names. Leave it out when you pass `messageId`.'
    ),
})

const channelIdMessage =
  'Pass a `channelId` from channels_list, or leave it out to count the whole server'

const contentContainsMessage =
  'Write the text to look for, as it would read in a message'

const groupByMessage =
  'Group the count by `day`, or leave it out for the total alone'

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const countWindowMessage =
  'Give `since` an instant at or before `until` — the window runs forward from `since` to `until`'

const countMessagesSchema = z
  .object({
    channelId: z
      .string({ error: channelIdMessage })
      .min(1, channelIdMessage)
      .optional()
      .describe(
        'Count only what was posted in one channel: the `channelId` from channels_list — not the Discord channel snowflake. Left out, the whole server is counted.'
      ),
    contentContains: z
      .string({ error: contentContainsMessage })
      .min(1, contentContainsMessage)
      .optional()
      .describe(
        'Count only the messages whose text, or the text of an embed on them, carries this — plain text matched without regard to case, not a pattern. An alert that says everything in an embed is matched on that text, and only the wording a message carries now is read. Left out, every message in range is counted.'
      ),
    groupBy: z
      .literal('day', { error: groupByMessage })
      .optional()
      .describe(
        'Break the answer into one bucket per UTC day alongside the total — how a day-by-day baseline is read. `day` is the only grouping there is. Left out, you get the total alone.'
      ),
    since: z.iso
      .datetime({ error: isoInstantMessage, offset: true })
      .optional()
      .describe(
        "Count only messages posted at or after this instant, on Discord's own send time. An ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed). Left out, the count reaches back to the oldest message the store holds."
      ),
    until: z.iso
      .datetime({ error: isoInstantMessage, offset: true })
      .optional()
      .describe(
        "Count only messages posted at or before this instant, on Discord's own send time. An ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed). Left out, the count runs to the newest message the store holds."
      ),
  })
  .refine(
    ({ since, until }) =>
      since === undefined ||
      until === undefined ||
      Date.parse(since) <= Date.parse(until),
    { error: countWindowMessage }
  )
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

function repliedTo({
  discordChannelId,
  discordGuildId,
  discordMessageId,
  messageId,
}: z.infer<typeof storedReplyReferenceSchema>) {
  return {
    discordMessageId,
    jumpUrl: `https://discord.com/channels/${discordGuildId}/${discordChannelId}/${discordMessageId}`,
    messageId,
  }
}

function storedRepliedTo(replyReference: string | null) {
  if (!replyReference) return null

  return repliedTo(storedReplyReferenceSchema.parse(JSON.parse(replyReference)))
}

function renderEmoji({ animated, id, name }: ObservedEmoji) {
  if (!id) return name
  if (!name) return `:${id}`

  return animated ? `a:${name}:${id}` : `${name}:${id}`
}

export {
  MessageFetchGoneError,
  MessageFetchRejectedError,
  countMessagesSchema,
  countWindowMessage,
  fetchMessageSchema,
  messageAttachmentsSchema,
  messageEmbedsSchema,
  messageFetchFailureCopy,
  messageFetchGuidance,
  messageFetchRetrievalCopy,
  messageFetchSkipCopy,
  messageLinkMessage,
  messageLinkTarget,
  messageReactionsSchema,
  observedAttachmentSchema,
  observedEmbedSchema,
  observedEmojiSchema,
  observedReplyReferenceSchema,
  oneLocatorMessage,
  renderEmbed,
  renderEmoji,
  repliedTo,
  storedRepliedTo,
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
  ObservedReplyReference,
}
