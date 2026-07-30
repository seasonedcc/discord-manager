import { z } from 'zod'
import type { GatewayActivity } from '~/business/ingestion.common'

type BackfillStatus = 'completed' | 'failed' | 'never' | 'running' | 'stalled'

type IngestionGuidance = {
  summary: string
  nextAction: string
}

const backfillStatusCopy = {
  completed: {
    summary:
      'Every channel the bot backfilled has finished pulling its history.',
    nextAction:
      'Catch up on messages whenever you like — the history is in the store.',
  },
  failed: {
    summary:
      'A channel backfill stopped on an error, so part of the history is missing.',
    nextAction:
      'Give the bot Read Message History in that channel, then restart the ingest daemon to backfill it again.',
  },
  never: {
    summary: 'No channel history has been backfilled in this server yet.',
    nextAction:
      'Run the ingest daemon with pnpm run ingest — it backfills every channel it can read on startup.',
  },
  running: {
    summary: 'The bot is still pulling channel history from Discord.',
    nextAction:
      'Read this status again in a few minutes to watch the counts move.',
  },
  stalled: {
    summary:
      'A channel backfill stopped without finishing and without failing.',
    nextAction:
      'Restart the ingest daemon with pnpm run ingest to pick that history up again.',
  },
} satisfies Record<BackfillStatus, IngestionGuidance>

const gatewayActivityCopy = {
  never: {
    summary: 'The bot has never connected to Discord, so nothing was ingested.',
    nextAction:
      'Run the ingest daemon with pnpm run ingest, and check DISCORD_BOT_TOKEN and DISCORD_GUILD_ID if it cannot connect.',
  },
  quiet: {
    summary: 'The bot has been off Discord for more than five minutes.',
    nextAction:
      'Check that the ingest daemon is still running, and start it again with pnpm run ingest.',
  },
  receiving: {
    summary: 'The bot was connected and recording as of moments ago.',
    nextAction: 'Nothing to fix — catch up on messages whenever you like.',
  },
} satisfies Record<GatewayActivity, IngestionGuidance>

const readIngestionStatusSchema = z.object({})

export { backfillStatusCopy, gatewayActivityCopy, readIngestionStatusSchema }
export type { BackfillStatus, IngestionGuidance }
