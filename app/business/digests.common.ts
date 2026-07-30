import { z } from 'zod'

const DIGEST_MESSAGE_LIMIT = 200

const catchUpSinceSchema = z.object({
  since: z.iso.datetime(),
  channelId: z.string().min(1).optional(),
})

const listMentionsSchema = z.object({
  since: z.iso.datetime(),
})

export { DIGEST_MESSAGE_LIMIT, catchUpSinceSchema, listMentionsSchema }
