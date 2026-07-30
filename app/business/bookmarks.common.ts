import { z } from 'zod'

const addBookmarkByLinkSchema = z.object({
  messageLink: z.string().min(1),
})

const listBookmarksSchema = z.object({
  includeSnoozed: z.boolean().optional(),
})

const resolveBookmarkSchema = z.object({
  messageId: z.string().min(1),
})

const snoozeBookmarkSchema = z.object({
  messageId: z.string().min(1),
  until: z.iso.datetime(),
})

export {
  addBookmarkByLinkSchema,
  listBookmarksSchema,
  resolveBookmarkSchema,
  snoozeBookmarkSchema,
}
