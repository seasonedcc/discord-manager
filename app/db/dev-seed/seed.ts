import { existsSync } from 'node:fs'
import { type Result, fromSuccess } from 'composable-functions'
import { sql } from 'kysely'
import type { z } from 'zod'
import { ownerContext } from '~/business/auth.server'
import type {
  addBookmarkByLinkSchema,
  listBookmarkReasonsSchema,
} from '~/business/bookmarks.common'
import {
  addBookmarkByLink,
  listBookmarkReasons,
} from '~/business/bookmarks.server'
import {
  recordChannelArchiving,
  type recordChannelArchivingSchema,
  recordChannelSnapshot,
  type recordChannelSnapshotSchema,
  recordGatewayConnection,
  type recordGatewayConnectionSchema,
  recordIncomingMessage,
  type recordIncomingMessageSchema,
} from '~/business/ingestion.server'
import type { fetchMessageSchema } from '~/business/messages.common'
import { fetchMessage } from '~/business/messages.server'
import {
  TransportRejectedError,
  type sendMessageSchema,
} from '~/business/sending.common'
import { sendMessage } from '~/business/sending.server'
import { db } from '~/db/db.server'
import { refusalForNonNumericIds } from '~/db/dev-seed/configured-ids'
import {
  type ObservedReaction,
  handleReactionAdded,
  handleReactionRemoved,
} from '~/ingest/gateway.server'

if (existsSync('.env')) process.loadEnvFile()

type ObservedChannel = z.input<typeof recordChannelSnapshotSchema>

type ObservedChannelDetails = Omit<
  ObservedChannel,
  'discordChannelId' | 'isThread'
>

type ObservedMessage = z.input<typeof recordIncomingMessageSchema>

const context = ownerContext()

let issuedIds = 0

function nextDiscordId() {
  issuedIds += 1

  return `9${String(issuedIds).padStart(17, '0')}`
}

async function readAnchor() {
  const { rows } = await sql<{
    anchor: string
  }>`select strftime('%Y-%m-%dT%H:%M:%fZ','now') as anchor`.execute(db())

  return rows[0].anchor
}

const tablesTheSchemaShipsPopulated = [
  'bookmark_reason_detail_revisions',
  'bookmark_reasons',
]

async function applicationTables() {
  const { rows } = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name not like 'kysely%'
    order by name
  `.execute(db())

  return rows
    .map(({ name }) => name)
    .filter((name) => !tablesTheSchemaShipsPopulated.includes(name))
}

function guardTheConfiguredDiscordIds() {
  const refusal = refusalForNonNumericIds({
    guildId: context.owner.guildId,
    ownerUserId: context.owner.discordUserId,
  })

  if (!refusal) return

  console.error(refusal)
  process.exit(1)
}

async function guardAnEmptyDatabase() {
  const populated: string[] = []

  for (const table of await applicationTables()) {
    const { rows } = await sql<{ present: number }>`
      select exists(select 1 from ${sql.table(table)}) as present
    `.execute(db())

    if (rows[0]?.present) populated.push(table)
  }

  if (populated.length > 0) {
    console.error(
      `This seed only runs on a freshly created, empty database, but these tables already hold rows: ${populated.join(', ')}. Point DATABASE_PATH at a new file, run pnpm run db:migrate, then seed it.`
    )
    process.exit(1)
  }
}

async function observeChannel(channel: ObservedChannelDetails) {
  const observed = {
    ...channel,
    discordChannelId: nextDiscordId(),
    isThread: false,
  } satisfies ObservedChannel

  await fromSuccess(recordChannelSnapshot)(observed, context)

  return observed
}

async function observeThread(thread: ObservedChannelDetails) {
  const observed = {
    ...thread,
    discordChannelId: nextDiscordId(),
    isThread: true,
  } satisfies ObservedChannel

  await fromSuccess(recordChannelSnapshot)(observed, context)

  return observed
}

async function postMessage({
  attachments = [],
  author,
  channel,
  content,
  discordCreatedAt,
  embeds = [],
  mentionedDiscordUserIds = [],
}: Pick<
  ObservedMessage,
  'author' | 'channel' | 'content' | 'discordCreatedAt'
> &
  Partial<
    Pick<ObservedMessage, 'attachments' | 'embeds' | 'mentionedDiscordUserIds'>
  >) {
  const discordMessageId = nextDiscordId()

  const { messageId } = await fromSuccess(recordIncomingMessage)(
    {
      attachments,
      author,
      channel,
      content,
      discordCreatedAt,
      discordMessageId,
      embeds,
      mentionedDiscordUserIds,
    } satisfies ObservedMessage,
    context
  )

  return { discordMessageId, messageId }
}

function recordedByTheGateway(
  recorded: Record<string, Result<unknown>> | undefined
) {
  if (!recorded) {
    throw new Error(
      'The seed aimed a reaction at a server this deployment does not manage'
    )
  }

  for (const [what, result] of Object.entries(recorded)) {
    if (result.success) continue

    throw new Error(
      `The seed could not record the ${what} of a reaction: ${result.errors.map((error) => error.message).join(', ')}`
    )
  }
}

async function reactToMessage(
  reaction: Omit<ObservedReaction, 'discordGuildId'>
) {
  recordedByTheGateway(
    await handleReactionAdded({
      ...reaction,
      discordGuildId: context.owner.guildId,
    })
  )
}

async function undoReaction(
  reaction: Omit<ObservedReaction, 'discordGuildId'>
) {
  recordedByTheGateway(
    await handleReactionRemoved({
      ...reaction,
      discordGuildId: context.owner.guildId,
    })
  )
}

guardTheConfiguredDiscordIds()
await guardAnEmptyDatabase()

const anchor = await readAnchor()
const secondsAfterTheAnchor = (seconds: number) =>
  new Date(Date.parse(anchor) + seconds * 1000).toISOString()

const maya = {
  discordUserId: nextDiscordId(),
  displayName: 'Maya Fischer',
  username: 'maya',
}
const omar = {
  discordUserId: nextDiscordId(),
  displayName: 'Omar Duarte',
  username: 'omar',
}
const uptimeWatch = {
  discordUserId: nextDiscordId(),
  displayName: 'Uptime Watch',
  username: 'uptime-watch',
}

await fromSuccess(recordGatewayConnection)(
  {} satisfies z.input<typeof recordGatewayConnectionSchema>,
  context
)

const announcements = await observeChannel({
  category: 'Company',
  name: 'announcements',
  position: 0,
  topic: 'Where the whole team hears things first',
})
const engineering = await observeChannel({
  category: 'Teams',
  name: 'engineering',
  position: 1,
  topic: 'Where the product gets built',
})

await postMessage({
  author: maya,
  channel: announcements,
  content: 'The team offsite is booked — the agenda is in the handbook.',
  discordCreatedAt: secondsAfterTheAnchor(1),
})

const bookmarkWorthy = await postMessage({
  author: omar,
  channel: engineering,
  content:
    'The deploy checklist moved to the handbook — read it before Friday.',
  discordCreatedAt: secondsAfterTheAnchor(2),
})

const awaitingAnAnswer = await postMessage({
  author: omar,
  channel: engineering,
  content: `<@${context.owner.discordUserId}> can you review the release notes today?`,
  discordCreatedAt: secondsAfterTheAnchor(3),
  mentionedDiscordUserIds: [context.owner.discordUserId],
})

await postMessage({
  author: maya,
  channel: engineering,
  content: 'Reading them now — I will leave comments before lunch.',
  discordCreatedAt: secondsAfterTheAnchor(4),
  mentionedDiscordUserIds: [context.owner.discordUserId],
})

const alert = await postMessage({
  attachments: [
    {
      filename: 'checkout-errors.png',
      size: 20480,
      url: 'https://cdn.example.test/attachments/checkout-errors.png',
    },
  ],
  author: uptimeWatch,
  channel: engineering,
  content: '',
  discordCreatedAt: secondsAfterTheAnchor(6),
  embeds: [
    {
      authorName: 'Uptime Watch',
      description: 'Checkout answered 502 five times in a row.',
      fields: [
        { name: 'Region', value: 'eu-west-1' },
        { name: 'Since', value: '4 minutes ago' },
      ],
      footerText: 'Acknowledge to stop the reminders',
      title: 'Checkout is failing',
      url: 'https://status.example.test/incidents/412',
    },
  ],
})

for (const reaction of [
  {
    discordMessageId: bookmarkWorthy.discordMessageId,
    emoji: { name: '🔖' },
    reactorDiscordUserId: context.owner.discordUserId,
  },
  {
    discordMessageId: awaitingAnAnswer.discordMessageId,
    emoji: { name: '👍' },
    reactorDiscordUserId: context.owner.discordUserId,
  },
  {
    discordMessageId: awaitingAnAnswer.discordMessageId,
    emoji: { name: '👀' },
    reactorDiscordUserId: maya.discordUserId,
  },
  {
    discordMessageId: bookmarkWorthy.discordMessageId,
    emoji: { animated: true, id: nextDiscordId(), name: 'shipit' },
    reactorDiscordUserId: omar.discordUserId,
  },
  {
    discordMessageId: bookmarkWorthy.discordMessageId,
    emoji: { name: '🎉' },
    reactorDiscordUserId: maya.discordUserId,
  },
]) {
  await reactToMessage(reaction)
}

await undoReaction({
  discordMessageId: bookmarkWorthy.discordMessageId,
  emoji: { name: '🎉' },
  reactorDiscordUserId: maya.discordUserId,
})

const { reasons } = await fromSuccess(listBookmarkReasons)(
  {} satisfies z.input<typeof listBookmarkReasonsSchema>,
  context
)
const answerLater = reasons.find(({ name }) => name === 'Answer later')

if (!answerLater) {
  throw new Error(
    'The Answer later bookmark reason is missing — run pnpm run db:migrate before seeding.'
  )
}

await fromSuccess(addBookmarkByLink)(
  {
    messageLink: `https://discord.com/channels/${context.owner.guildId}/${engineering.discordChannelId}/${awaitingAnAnswer.discordMessageId}`,
    reasonId: answerLater.reasonId,
  } satisfies z.input<typeof addBookmarkByLinkSchema>,
  context
)

const retiredThread = await observeThread({
  category: 'Teams',
  name: 'hotfix-thursday',
})

await postMessage({
  author: maya,
  channel: retiredThread,
  content: 'Hotfix is out — nothing left to do here.',
  discordCreatedAt: secondsAfterTheAnchor(5),
})

await fromSuccess(recordChannelArchiving)(
  {
    discordChannelId: retiredThread.discordChannelId,
  } satisfies z.input<typeof recordChannelArchivingSchema>,
  context
)

const engineeringChannel = await db()
  .selectFrom('channels')
  .select('id')
  .where('discordChannelId', '=', engineering.discordChannelId)
  .executeTakeFirstOrThrow()

const refusedSend = await fromSuccess(
  sendMessage(async () => {
    throw new TransportRejectedError('Missing Permissions')
  })
)(
  {
    channelId: engineeringChannel.id,
    content: 'Reminder: the deploy checklist is in the handbook now.',
  } satisfies z.input<typeof sendMessageSchema>,
  context
)

await fromSuccess(
  fetchMessage(async () => ({
    attachments: [
      {
        filename: 'checkout-errors.png',
        size: 20480,
        url: 'https://cdn.example.test/attachments/checkout-errors.png?signed=just-now',
      },
    ],
    content: '',
    embeds: [
      {
        authorName: 'Uptime Watch',
        description: 'Checkout has been answering 200 again for ten minutes.',
        title: 'Checkout recovered',
        url: 'https://status.example.test/incidents/412',
      },
    ],
    reactions: [
      {
        count: 2,
        emoji: '🎉',
        reactorDiscordUserIds: [
          maya.discordUserId,
          context.owner.discordUserId,
        ],
      },
    ],
  }))
)(
  { messageId: alert.messageId } satisfies z.input<typeof fetchMessageSchema>,
  context
)

await db().destroy()

console.log(
  `Seeded a development server: two channels, an archived thread, six messages — one of them an alert that says everything in an embed and carries a screenshot — one mention of you that you answered with a 👍 rather than words, one reply that pinged you without naming you, reactions on two messages including a custom one and one a teammate took back, two bookmarks — one captured with the 🔖 reaction that still shows on the message and still sitting in Inbox, one filed under Answer later — one send Discord refused, and one live fetch of that alert already recorded. Start the MCP server with pnpm run mcp, ask your assistant to catch up on #engineering, and read messages_send_status for request ${refusedSend.send.requestId} to see the guarded retry it offers. Leave messages_fetch out of the tour: it goes to Discord live, so it only answers against a real server with real credentials.`
)
