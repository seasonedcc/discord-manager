import { z } from 'zod'

const digestMessageLimit = 200

const isoInstantMessage =
  'Use an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed)'

const channelIdMessage =
  'Pass a `channelId` from channels_list, or leave it out to read the whole server'

const sinceSchema = z.iso
  .datetime({ error: isoInstantMessage, offset: true })
  .describe(
    'Bring back everything posted at or after this instant, as an ISO-8601 timestamp such as 2026-07-30T09:00:00Z (offsets allowed).'
  )

const catchUpSinceSchema = z.object({
  since: sinceSchema,
  channelId: z
    .string({ error: channelIdMessage })
    .min(1, channelIdMessage)
    .optional()
    .describe(
      'Narrow the digest to one channel: the `channelId` from channels_list — not the Discord channel snowflake. Left out, the whole server is read.'
    ),
})

const listMentionsSchema = z.object({ since: sinceSchema })

export { catchUpSinceSchema, digestMessageLimit, listMentionsSchema }
