import { z } from 'zod'

const bookmarkListLimit = 100

const bookmarkListMaximumLimit = 500

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const addBookmarkByLinkSchema = z.object({
  messageLink: z
    .string()
    .min(1)
    .describe(
      'A Discord message link, from Copy Message Link in Discord: https://discord.com/channels/<server>/<channel>/<message>. Links from canary.discord.com, ptb.discord.com and discordapp.com work too.'
    ),
})

const listBookmarksSchema = z.object({
  includeSnoozed: z
    .boolean()
    .optional()
    .describe(
      'Set true to include bookmarks snoozed until a later moment. Left out, snoozed bookmarks stay hidden.'
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

export {
  addBookmarkByLinkSchema,
  bookmarkListLimit,
  listBookmarksSchema,
  resolveBookmarkSchema,
  snoozeBookmarkSchema,
}
