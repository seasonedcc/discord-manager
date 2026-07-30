import { z } from 'zod'
import { env } from '~/env.server'

const ownerSchema = z.object({
  discordUserId: z.string().min(1),
  guildId: z.string().min(1),
})

const ownerContextSchema = z.object({
  owner: ownerSchema,
  canReadMessages: z.literal(true),
  canManageBookmarks: z.literal(true),
  canSendMessages: z.literal(true),
})

function ownerCaps() {
  return {
    canReadMessages: true as const,
    canManageBookmarks: true as const,
    canSendMessages: true as const,
  }
}

function ownerContext() {
  return {
    owner: {
      discordUserId: env().discordOwnerUserId,
      guildId: env().discordGuildId,
    },
    ...ownerCaps(),
  }
}

export { ownerCaps, ownerContext, ownerContextSchema }
