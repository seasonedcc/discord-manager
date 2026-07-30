import { z } from 'zod'

const digestMessageLimit = 200

const catchUpSinceSchema = z.object({
  since: z.iso.datetime(),
  channelId: z.string().min(1).optional(),
})

const listMentionsSchema = z.object({
  since: z.iso.datetime(),
})

export { catchUpSinceSchema, digestMessageLimit, listMentionsSchema }
