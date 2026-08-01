import { z } from 'zod'

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

const messageEmbedsSchema = z.array(z.string())

const messageAttachmentsSchema = z.array(observedAttachmentSchema)

type ObservedEmbed = z.infer<typeof observedEmbedSchema>

type ObservedAttachment = z.infer<typeof observedAttachmentSchema>

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

export {
  messageAttachmentsSchema,
  messageEmbedsSchema,
  observedAttachmentSchema,
  observedEmbedSchema,
  renderEmbed,
}
export type { ObservedAttachment, ObservedEmbed }
