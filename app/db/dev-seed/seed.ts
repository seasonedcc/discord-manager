import { existsSync } from 'node:fs'
import { fromSuccess } from 'composable-functions'
import { sql } from 'kysely'
import { ownerContext } from '~/business/auth.server'
import {
  recordChannelArchiving,
  recordChannelSnapshot,
  recordGatewayConnection,
  recordIncomingMessage,
  recordOwnerBookmarkReaction,
} from '~/business/ingestion.server'
import { db } from '~/db/db.server'

if (existsSync('.env')) process.loadEnvFile()

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

async function applicationTables() {
  const { rows } = await sql<{ name: string }>`
    select name from sqlite_master
    where type = 'table' and name not like 'kysely%'
    order by name
  `.execute(db())

  return rows.map(({ name }) => name)
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

async function observeChannel(channel: {
  category: string
  name: string
  position?: number
  topic?: string
}) {
  const observed = {
    ...channel,
    discordChannelId: nextDiscordId(),
    isThread: false,
  }

  await fromSuccess(recordChannelSnapshot)(observed, context)

  return observed
}

async function observeThread(thread: { category: string; name: string }) {
  const observed = {
    ...thread,
    discordChannelId: nextDiscordId(),
    isThread: true,
  }

  await fromSuccess(recordChannelSnapshot)(observed, context)

  return observed
}

async function postMessage({
  author,
  channel,
  content,
  discordCreatedAt,
  mentionedDiscordUserIds = [],
}: {
  author: { discordUserId: string; displayName: string; username: string }
  channel: Awaited<ReturnType<typeof observeChannel | typeof observeThread>>
  content: string
  discordCreatedAt: string
  mentionedDiscordUserIds?: string[]
}) {
  const discordMessageId = nextDiscordId()

  await fromSuccess(recordIncomingMessage)(
    {
      author,
      channel,
      content,
      discordCreatedAt,
      discordMessageId,
      mentionedDiscordUserIds,
    },
    context
  )

  return { discordMessageId }
}

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

await fromSuccess(recordGatewayConnection)({}, context)

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

await postMessage({
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

await fromSuccess(recordOwnerBookmarkReaction)(
  {
    discordMessageId: bookmarkWorthy.discordMessageId,
    emoji: '🔖',
    reactorDiscordUserId: context.owner.discordUserId,
  },
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
  { discordChannelId: retiredThread.discordChannelId },
  context
)

await db().destroy()

console.log(
  'Seeded a development server: two channels, an archived thread, five messages, one mention of you, one reply that pinged you without naming you, and one bookmark. Start the MCP server with pnpm run mcp and ask your assistant to list the channels.'
)
