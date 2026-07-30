import { z } from 'zod'

const bookmarkListLimit = 100

const bookmarkListMaximumLimit = 500

const inboxBookmarkReasonId = '019fb556-c241-7001-b011-99f205b9fa06'

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const reasonIdDescription =
  'The `reasonId` of a bookmark reason, from bookmark_reasons_list.'

const addBookmarkByLinkSchema = z.object({
  messageLink: z
    .string()
    .min(1)
    .describe(
      'A Discord message link, from Copy Message Link in Discord: https://discord.com/channels/<server>/<channel>/<message>. Links from canary.discord.com, ptb.discord.com and discordapp.com work too.'
    ),
  reasonId: z
    .string()
    .min(1)
    .describe(
      'Why this message is being bookmarked. Call bookmark_reasons_list first and pick the `reasonId` that matches the intent — Inbox when there is no intent to record yet.'
    ),
})

const listBookmarksSchema = z.object({
  includeSnoozed: z
    .boolean()
    .optional()
    .describe(
      'Set true to include bookmarks snoozed until a later moment. Left out, snoozed bookmarks stay hidden.'
    ),
  reasonId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Bring back only the bookmarks carrying this reason, from bookmark_reasons_list. Retired reasons still filter, since bookmarks keep the reason they were given. Left out, every reason comes back.'
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(bookmarkListMaximumLimit)
    .default(bookmarkListLimit)
    .describe(
      `How many bookmarks to bring back, most recently bookmarked first. Up to ${bookmarkListMaximumLimit}, ${bookmarkListLimit} by default.`
    ),
})

const resolveBookmarkSchema = z.object({
  messageId: z
    .string()
    .min(1)
    .describe(
      'The `messageId` from bookmarks_list — not the Discord message snowflake.'
    ),
})

const snoozeBookmarkSchema = z.object({
  messageId: z
    .string()
    .min(1)
    .describe(
      'The `messageId` from bookmarks_list — not the Discord message snowflake.'
    ),
  until: z.iso
    .datetime({ error: isoInstantMessage, offset: true })
    .describe(
      'When the bookmark should come back, as an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed).'
    ),
})

const setBookmarkReasonSchema = z.object({
  messageId: z
    .string()
    .min(1)
    .describe(
      'The `messageId` from bookmarks_list — not the Discord message snowflake.'
    ),
  reasonId: z
    .string()
    .min(1)
    .describe(
      'The reason to give this bookmark, from bookmark_reasons_list. Inbox is allowed, and sends the bookmark back to be sorted again.'
    ),
})

const listBookmarkReasonsSchema = z.object({})

const addBookmarkReasonSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What to call this reason in bookmark listings, such as Delegate or Waiting on finance.'
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .describe(
      'When this reason applies, in a sentence. This is what an assistant reads to decide which reason a bookmark belongs to.'
    ),
})

const editBookmarkReasonSchema = z.object({
  reasonId: z.string().min(1).describe(reasonIdDescription),
  name: z
    .string()
    .trim()
    .min(1)
    .describe(
      'What to call this reason from now on. Bookmarks already carrying it show the new name.'
    ),
  description: z
    .string()
    .trim()
    .min(1)
    .describe(
      'When this reason applies, in a sentence. Both the name and the description are rewritten, so pass the wording you want to keep.'
    ),
})

const retireBookmarkReasonSchema = z.object({
  reasonId: z.string().min(1).describe(reasonIdDescription),
})

export {
  addBookmarkByLinkSchema,
  addBookmarkReasonSchema,
  editBookmarkReasonSchema,
  inboxBookmarkReasonId,
  listBookmarkReasonsSchema,
  listBookmarksSchema,
  resolveBookmarkSchema,
  retireBookmarkReasonSchema,
  setBookmarkReasonSchema,
  snoozeBookmarkSchema,
}
