import { fromSuccess } from 'composable-functions'
import { readActivitySince } from '~/business/activity.server'
import type { ownerContext } from '~/business/auth.server'
import { inboxBookmarkReasonId } from '~/business/bookmarks.common'
import {
  addBookmarkByLink,
  addBookmarkReason,
  editBookmarkReason,
  listBookmarkReasons,
  listBookmarks,
  resolveBookmark,
  retireBookmarkReason,
  setBookmarkReason,
  snoozeBookmark,
} from '~/business/bookmarks.server'
import { listChannels } from '~/business/channels.server'
import { catchUpSince, listMentions } from '~/business/digests.server'
import { readIngestionStatus } from '~/business/ingestion-status.server'
import { readMessageSendStatus } from '~/business/sending.server'
import { db } from '~/db/db.server'

type ToolName =
  | 'activity_since'
  | 'bookmark_reasons_add'
  | 'bookmark_reasons_edit'
  | 'bookmark_reasons_list'
  | 'bookmark_reasons_retire'
  | 'bookmarks_add'
  | 'bookmarks_list'
  | 'bookmarks_resolve'
  | 'bookmarks_set_reason'
  | 'bookmarks_snooze'
  | 'channels_list'
  | 'ingestion_status'
  | 'mentions_list'
  | 'messages_catch_up'
  | 'messages_fetch'
  | 'messages_send'
  | 'messages_send_status'

type OwnerContext = ReturnType<typeof ownerContext>

type SeedDemonstration = {
  demonstrates: string
  prove: (context: OwnerContext) => Promise<string>
}

const gateSource = 'tests/seed-coverage/demonstrations.ts'

const declaredUnseedable = {
  messages_fetch:
    'reads one message live from Discord, so no local store can answer for it — the README says under "Try it before inviting a bot" that it needs a real bot token and a real server',
  messages_send:
    'posts to a channel through Discord, so no local store can answer for it — the README says under "Try it before inviting a bot" that sending fails on demo credentials, which is why the seed leaves a refused send behind for messages_send_status to read',
} satisfies Partial<Record<ToolName, string>>

type UnseedableTool = keyof typeof declaredUnseedable

const aDayInMilliseconds = 24 * 60 * 60 * 1000

function anInstantBeforeTheSeedRan() {
  return new Date(Date.now() - aDayInMilliseconds).toISOString()
}

function anInstantAfterTheTour() {
  return new Date(Date.now() + aDayInMilliseconds).toISOString()
}

async function bookmarksOnTheList(
  context: OwnerContext,
  includeSnoozed = false
) {
  const { bookmarks } = await fromSuccess(listBookmarks)(
    { includeSnoozed },
    context
  )

  return bookmarks
}

async function aBookmarkOnTheList(context: OwnerContext, whatFor: string) {
  const [bookmark] = await bookmarksOnTheList(context)

  if (!bookmark) {
    throw new Error(
      `the seeded store leaves no bookmark on the list, so there is none to ${whatFor}`
    )
  }

  return bookmark
}

async function aBookmarkFiledOutsideInbox(context: OwnerContext) {
  const filed = (await bookmarksOnTheList(context)).find(
    ({ reasonId }) => reasonId !== inboxBookmarkReasonId
  )

  if (!filed) {
    throw new Error(
      'no seeded bookmark is filed under a reason of its own, and Inbox belongs to the product, so there is no reason here that may be reworded or retired'
    )
  }

  return filed
}

async function reasonsBookmarksCanBeFiledUnder(context: OwnerContext) {
  const { reasons } = await fromSuccess(listBookmarkReasons)({}, context)

  return reasons
}

async function aMessageNobodyBookmarkedYet(context: OwnerContext) {
  const { messages } = await fromSuccess(catchUpSince)(
    { since: anInstantBeforeTheSeedRan() },
    context
  )
  const bookmarked = new Set(
    (await bookmarksOnTheList(context, true)).map(({ messageId }) => messageId)
  )
  const spare = messages.find(({ messageId }) => !bookmarked.has(messageId))

  if (!spare) {
    throw new Error(
      'every message the seed ingested is already bookmarked, so no Discord link is left to capture'
    )
  }

  return spare
}

async function theSendTheSeedLeftBehind() {
  const request = await db()
    .selectFrom('messageSendRequests')
    .select('id')
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .executeTakeFirst()

  if (!request) {
    throw new Error(
      'the seeded store records no message send, so there is no standing to read'
    )
  }

  return request.id
}

const seedDemonstrations: Record<
  Exclude<ToolName, UnseedableTool>,
  SeedDemonstration
> = {
  ingestion_status: {
    demonstrates: 'a bot that is receiving from Discord right now',
    prove: async (context) => {
      const { ingestion } = await fromSuccess(readIngestionStatus)({}, context)

      if (ingestion.gateway.activity !== 'receiving') {
        throw new Error(
          `the seeded store makes the gateway read as "${ingestion.gateway.activity}", so the demo opens on a bot that is not listening`
        )
      }

      return `gateway ${ingestion.gateway.activity}, backfill ${ingestion.backfill.status}`
    },
  },
  channels_list: {
    demonstrates: 'the channels the bot can see, one of them a thread',
    prove: async (context) => {
      const { channels } = await fromSuccess(listChannels)({}, context)

      if (channels.length === 0) {
        throw new Error(
          'the seeded store holds no channel, so the channel list answers empty'
        )
      }

      const threads = channels.filter(({ isThread }) => isThread)

      if (threads.length === 0) {
        throw new Error(
          'the seeded store holds no thread, so the archived half of the channel list never shows'
        )
      }

      return `${channels.length} channels, ${threads.length} of them threads`
    },
  },
  activity_since: {
    demonstrates: 'a poll that comes back with something to read',
    prove: async (context) => {
      const { activity } = await fromSuccess(readActivitySince)(
        { since: anInstantBeforeTheSeedRan() },
        context
      )
      const silent = Object.entries(activity)
        .filter(([, stream]) => stream.count === 0)
        .map(([stream]) => stream)

      if (silent.length > 0) {
        throw new Error(
          `the seeded store recorded nothing under ${silent.join(' or ')} in the last day, so a poll answers zeros there`
        )
      }

      return `${activity.messages.count} messages, ${activity.mentions.count} mentions, ${activity.bookmarkAdditions.count} bookmark additions`
    },
  },
  messages_catch_up: {
    demonstrates:
      'a digest carrying text, an embed, an attachment and reactions',
    prove: async (context) => {
      const since = anInstantBeforeTheSeedRan()
      const { messages } = await fromSuccess(catchUpSince)({ since }, context)

      if (messages.length === 0) {
        throw new Error(
          'the seeded store holds no message, so the catch-up answers empty'
        )
      }

      const carried = [
        ['an embed', messages.some(({ embeds }) => embeds.length > 0)],
        [
          'an attachment',
          messages.some(({ attachments }) => attachments.length > 0),
        ],
        ['a reaction', messages.some(({ reactions }) => reactions.length > 0)],
      ] as const

      for (const [what, present] of carried) {
        if (present) continue

        throw new Error(
          `no seeded message carries ${what}, so that part of a catch-up row never reads`
        )
      }

      const { channelId } = messages[0]
      const narrowed = await fromSuccess(catchUpSince)(
        { channelId, since },
        context
      )

      if (narrowed.messages.length === 0) {
        throw new Error(
          'narrowing the catch-up to a seeded channel answers empty'
        )
      }

      return `${messages.length} messages, ${narrowed.messages.length} of them in one channel`
    },
  },
  mentions_list: {
    demonstrates: 'a ping waiting on the owner',
    prove: async (context) => {
      const { messages } = await fromSuccess(listMentions)(
        { since: anInstantBeforeTheSeedRan() },
        context
      )

      if (messages.length === 0) {
        throw new Error(
          'no seeded message pings the configured owner, so the mention list answers empty'
        )
      }

      return `${messages.length} messages that pinged you`
    },
  },
  bookmark_reasons_list: {
    demonstrates: 'reasons to file under, one of them already carrying work',
    prove: async (context) => {
      const reasons = await reasonsBookmarksCanBeFiledUnder(context)

      if (reasons.length === 0) {
        throw new Error(
          'the store offers no bookmark reason, so there is nothing to file a bookmark under'
        )
      }

      const carrying = reasons.filter(
        ({ bookmarkCount }) => (bookmarkCount ?? 0) > 0
      )

      if (carrying.length === 0) {
        throw new Error(
          'no seeded bookmark carries a reason, so every count on the reason list reads zero'
        )
      }

      return `${reasons.length} reasons, ${carrying.length} of them carrying bookmarks`
    },
  },
  bookmarks_list: {
    demonstrates: 'bookmarks waiting on the owner, each filed under a reason',
    prove: async (context) => {
      const bookmarks = await bookmarksOnTheList(context)

      if (bookmarks.length === 0) {
        throw new Error(
          'the seeded store holds no bookmark, so the bookmark list answers empty'
        )
      }

      const unnamed = bookmarks.filter(({ reasonName }) => !reasonName)

      if (unnamed.length > 0) {
        throw new Error(
          `${unnamed.length} seeded bookmarks come back without the name of the reason they carry`
        )
      }

      if (!bookmarks.some(({ reactions }) => reactions.length > 0)) {
        throw new Error(
          'no seeded bookmark carries a reaction, so a bookmark somebody already answered never reads as answered'
        )
      }

      const reasonNames = new Set(bookmarks.map(({ reasonName }) => reasonName))

      return `${bookmarks.length} bookmarks under ${reasonNames.size} reasons`
    },
  },
  messages_send_status: {
    demonstrates: 'the refused send the seed leaves behind, and its retry',
    prove: async (context) => {
      const requestId = await theSendTheSeedLeftBehind()
      const { send } = await fromSuccess(readMessageSendStatus)(
        { requestId },
        context
      )

      if (send.status === 'stalled') {
        throw new Error(
          'the seeded send never recorded an outcome, so its standing reads as stalled'
        )
      }

      if (!send.canRetry) {
        throw new Error(
          `the seeded ${send.status} send offers no retry, so the guarded retry the seed points at cannot be demonstrated`
        )
      }

      return `a ${send.status} send that can still be retried`
    },
  },
  bookmarks_add: {
    demonstrates: 'a seeded message captured from its Discord link',
    prove: async (context) => {
      const spare = await aMessageNobodyBookmarkedYet(context)
      const { bookmark } = await fromSuccess(addBookmarkByLink)(
        { messageLink: spare.jumpUrl, reasonId: inboxBookmarkReasonId },
        context
      )

      if (bookmark.messageId !== spare.messageId) {
        throw new Error(
          'bookmarking a seeded message link landed on a different message'
        )
      }

      return `captured a message from #${spare.channelName} as ${bookmark.reasonName}`
    },
  },
  bookmarks_set_reason: {
    demonstrates: 'a bookmark leaving Inbox for a reason of its own',
    prove: async (context) => {
      const bookmark = await aBookmarkOnTheList(context, 'file under a reason')
      const reasons = await reasonsBookmarksCanBeFiledUnder(context)
      const target = reasons.find(
        ({ reasonId }) => reasonId !== bookmark.reasonId
      )

      if (!target) {
        throw new Error(
          'the only reason on offer is the one this bookmark already carries, so there is nowhere to file it'
        )
      }

      const { bookmark: filed } = await fromSuccess(setBookmarkReason)(
        { messageId: bookmark.messageId, reasonId: target.reasonId },
        context
      )

      if (filed.reasonName !== target.name) {
        throw new Error(
          `filing a seeded bookmark answered with ${filed.reasonName} rather than ${target.name}`
        )
      }

      return `filed a bookmark under ${filed.reasonName}`
    },
  },
  bookmark_reasons_add: {
    demonstrates: 'a reason of your own beside the ones the store ships',
    prove: async (context) => {
      const shipped = await reasonsBookmarksCanBeFiledUnder(context)
      const { reason } = await fromSuccess(addBookmarkReason)(
        {
          name: 'Waiting on finance',
          description: 'Blocked until finance comes back with an answer.',
        },
        context
      )
      const offered = await reasonsBookmarksCanBeFiledUnder(context)

      if (!offered.some(({ reasonId }) => reasonId === reason.reasonId)) {
        throw new Error(
          `${reason.name} was added but does not come back on the reason list`
        )
      }

      return `${shipped.length} reasons on offer, now ${offered.length} with ${reason.name}`
    },
  },
  bookmark_reasons_edit: {
    demonstrates: 'a reason reworded under the bookmarks already carrying it',
    prove: async (context) => {
      const bookmark = await aBookmarkFiledOutsideInbox(context)
      const name = 'Answer before Friday'

      await fromSuccess(editBookmarkReason)(
        {
          description: 'A message waiting on a reply from you this week.',
          name,
          reasonId: bookmark.reasonId,
        },
        context
      )

      const reworded = (await bookmarksOnTheList(context, true)).find(
        ({ messageId }) => messageId === bookmark.messageId
      )

      if (reworded?.reasonName !== name) {
        throw new Error(
          `rewording ${bookmark.reasonName} left its bookmark reading ${reworded?.reasonName}`
        )
      }

      return `reworded ${bookmark.reasonName} to ${name} under a seeded bookmark`
    },
  },
  bookmark_reasons_retire: {
    demonstrates:
      'a reason taken out of circulation while its bookmarks keep it',
    prove: async (context) => {
      const bookmark = await aBookmarkFiledOutsideInbox(context)
      const { reason } = await fromSuccess(retireBookmarkReason)(
        { reasonId: bookmark.reasonId },
        context
      )
      const kept = (await bookmarksOnTheList(context, true)).find(
        ({ messageId }) => messageId === bookmark.messageId
      )

      if (kept?.reasonName !== reason.name) {
        throw new Error(
          `retiring ${reason.name} left its bookmark reading ${kept?.reasonName}`
        )
      }

      const stillOffered = (
        await reasonsBookmarksCanBeFiledUnder(context)
      ).some(({ reasonId }) => reasonId === reason.reasonId)

      if (stillOffered) {
        throw new Error(
          `${reason.name} was retired but is still on offer for new bookmarks`
        )
      }

      return `retired ${reason.name} with a bookmark still carrying it`
    },
  },
  bookmarks_snooze: {
    demonstrates: 'a bookmark kept out of the way until a moment you pick',
    prove: async (context) => {
      const bookmark = await aBookmarkOnTheList(context, 'snooze')
      const { bookmark: snoozed } = await fromSuccess(snoozeBookmark)(
        { messageId: bookmark.messageId, until: anInstantAfterTheTour() },
        context
      )
      const onTheDefaultList = (await bookmarksOnTheList(context)).some(
        ({ messageId }) => messageId === bookmark.messageId
      )

      if (onTheDefaultList) {
        throw new Error('the snoozed bookmark is still on the default list')
      }

      const comesBackWhenAsked = (await bookmarksOnTheList(context, true)).some(
        ({ messageId }) => messageId === bookmark.messageId
      )

      if (!comesBackWhenAsked) {
        throw new Error(
          'the snoozed bookmark does not come back when snoozed ones are asked for'
        )
      }

      return `snoozed a bookmark until ${snoozed.snoozedUntil}`
    },
  },
  bookmarks_resolve: {
    demonstrates: 'a bookmark cleared off the list once it is dealt with',
    prove: async (context) => {
      const bookmark = await aBookmarkOnTheList(context, 'resolve')
      const { bookmark: resolved } = await fromSuccess(resolveBookmark)(
        { messageId: bookmark.messageId },
        context
      )
      const stillListed = (await bookmarksOnTheList(context, true)).some(
        ({ messageId }) => messageId === bookmark.messageId
      )

      if (stillListed) {
        throw new Error('the resolved bookmark is still on the list')
      }

      return `resolved a bookmark via ${resolved.resolvedVia}`
    },
  },
}

function seedCoverageProblems(registeredNames: string[]) {
  const declaredNames = [
    ...Object.keys(seedDemonstrations),
    ...Object.keys(declaredUnseedable),
  ]
  const problems: string[] = []

  for (const name of registeredNames) {
    if (declaredNames.includes(name)) continue

    problems.push(
      `${name} is registered but this gate has never heard of it. Add it to ToolName in ${gateSource}, then either prove it against the seeded store or declare it unseedable with an honest reason.`
    )
  }

  for (const name of declaredNames) {
    if (registeredNames.includes(name)) continue

    problems.push(
      `${name} is covered in ${gateSource} but no tool by that name is registered. Drop it from ToolName.`
    )
  }

  return problems
}

export { declaredUnseedable, seedCoverageProblems, seedDemonstrations }
export type { SeedDemonstration, ToolName }
