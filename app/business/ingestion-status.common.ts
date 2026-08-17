import { z } from 'zod'
import type { GatewayActivity } from '~/business/ingestion.common'

type BackfillStatus =
  | 'completed'
  | 'failed'
  | 'never'
  | 'reactionsUnread'
  | 'running'
  | 'stalled'
  | 'unavailable'

type IngestionGuidance = {
  summary: string
  nextAction: string
}

const backfillStatusCopy = {
  completed: {
    summary: 'Every channel the bot has visited finished pulling its history.',
    nextAction:
      'Catch up on messages whenever you like — the history is in the store.',
  },
  failed: {
    summary:
      'A channel backfill stopped before it reached the newest messages, so part of the history is missing.',
    nextAction:
      'Restart the ingest daemon with pnpm run ingest — it picks each channel listed under failedChannelNames up from the last message it stored, and when a backfill keeps giving up on an error it prints what stopped it.',
  },
  never: {
    summary: 'No channel history has been backfilled in this server yet.',
    nextAction:
      'Run the ingest daemon with pnpm run ingest — it backfills every channel it can read on startup.',
  },
  reactionsUnread: {
    summary:
      'Every channel the bot has visited finished pulling its history, and Discord would not list who reacted to some of the messages it stored.',
    nextAction:
      'Read one of those messages with messages_fetch when its reactions matter — the backfill walks forward and never goes back for them. Check the bot has Read Message History in the channels listed under reactionsUnreadChannelNames so the next history it pulls arrives with them.',
  },
  running: {
    summary: 'Backfills are still working through the history.',
    nextAction:
      'Read this status again in a few minutes to watch the counts move.',
  },
  stalled: {
    summary:
      'A channel backfill stopped without finishing and without failing.',
    nextAction:
      'Restart the ingest daemon with pnpm run ingest to pick that history up again.',
  },
  unavailable: {
    summary:
      'Every channel the bot is allowed to read finished pulling its history. Discord denies it the channels listed under unavailableChannelNames, so no new history arrives from them — whatever was ingested before a denial stays in the store. That is a permission somebody set, not a backfill that went wrong.',
    nextAction:
      'Nothing to fix unless you want those channels flowing again — a server admin has to give the bot View Channel and Read Message History there, and the ingest daemon tries them again the next time it connects.',
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
