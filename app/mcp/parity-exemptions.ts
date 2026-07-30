type ParityExemption = {
  functionName: string
  reason: string
}

const parityExemptions: ParityExemption[] = [
  {
    functionName: 'auth.ownerCaps',
    reason:
      'Builds the capability flags every context carries. It is the gate itself, not something the owner asks for.',
  },
  {
    functionName: 'auth.ownerContext',
    reason:
      'Builds the owner context each transport hands to the business layer. It is the gate itself, not a capability.',
  },
  {
    functionName: 'ingestion.backfillChannel',
    reason:
      'A scheduler job the ingest daemon enqueues per channel. The owner reads what it produced through ingestion_status.',
  },
  {
    functionName: 'ingestion.backfillIngestedChannels',
    reason:
      'A scheduler job the ingest daemon runs on startup and after every reconnect. The owner reads what it produced through ingestion_status.',
  },
  {
    functionName: 'ingestion.beatGatewayHeartbeat',
    reason:
      'A scheduler job the ingest daemon ticks every minute so its liveness is on the record. The owner reads it through ingestion_status.',
  },
  {
    functionName: 'ingestion.listBackfillableChannels',
    reason:
      'Tells the daemon which channels its backfill sweep should visit. The owner-facing channel listing is channels_list.',
  },
  {
    functionName: 'ingestion.recordChannelRemoval',
    reason:
      'Records that a channel left the view of the bot, called by the gateway daemon on a Discord channel event.',
  },
  {
    functionName: 'ingestion.recordChannelSnapshot',
    reason:
      'Records how a channel looks right now, called by the gateway daemon on a Discord channel event.',
  },
  {
    functionName: 'ingestion.recordGatewayConnection',
    reason:
      'Records the link of the daemon to Discord coming up. The owner reads the resulting activity through ingestion_status.',
  },
  {
    functionName: 'ingestion.recordGatewayDisconnection',
    reason:
      'Records the link of the daemon to Discord dropping. The owner reads the resulting activity through ingestion_status.',
  },
  {
    functionName: 'ingestion.recordGatewayHeartbeat',
    reason:
      'Records the daemon liveness signal; the owner reads it through ingestion_status.',
  },
  {
    functionName: 'ingestion.recordIncomingMessage',
    reason:
      'Records a message the gateway just delivered, called by the daemon on every messageCreate event.',
  },
  {
    functionName: 'ingestion.recordMessageDeletion',
    reason:
      'Records a deletion the gateway just delivered, called by the daemon on every messageDelete event.',
  },
  {
    functionName: 'ingestion.recordMessageEdit',
    reason:
      'Records an edit the gateway just delivered, called by the daemon on every messageUpdate event.',
  },
  {
    functionName: 'ingestion.recordOwnerBookmarkReaction',
    reason:
      'Turns a 🔖 reaction in Discord into a bookmark, called by the daemon on a reaction event. Bookmarking from an assistant is bookmarks_add.',
  },
  {
    functionName: 'ingestion.recordOwnerBookmarkReactionRemoval',
    reason:
      'Turns an un-reaction in Discord into a bookmark removal, called by the daemon on a reaction event. Clearing a bookmark from an assistant is bookmarks_resolve.',
  },
  {
    functionName: 'ingestion.runChannelBackfill',
    reason:
      'Walks the history of one channel with the Discord REST transport only the daemon can supply. The owner reads its progress through ingestion_status.',
  },
]

export { parityExemptions }
export type { ParityExemption }
