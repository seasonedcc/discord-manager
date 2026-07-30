type BackfilledMessage = {
  author: {
    discordUserId: string
    displayName: string
    username: string
  }
  content: string
  discordCreatedAt: string
  discordMessageId: string
}

type FetchChannelHistory = (request: {
  afterDiscordMessageId: string
  discordChannelId: string
  limit: number
}) => Promise<BackfilledMessage[]>

type GatewayActivity = 'never' | 'quiet' | 'receiving'

type IngestionSkipReason =
  | 'channel_not_ingested'
  | 'emoji_is_not_the_bookmark_reaction'
  | 'message_not_ingested'
  | 'reactor_is_not_the_owner'

const bookmarkReactionEmoji = '🔖'

const backfillPageSize = 100

const backfillPageLimit = 200

// A backfill that has said nothing for fifteen minutes has outlived every
// scheduler retry, so nothing is still working on it.
const backfillStallThresholdMinutes = 15

const discordHistoryBeginningSnowflake = '0'

// A dropped shard reconnects well inside five minutes, so a disconnection still
// standing after that means nothing is bringing the link back on its own.
const gatewaySilenceThresholdMinutes = 5

function gatewaySilenceStartedAt(observedAt: string) {
  return new Date(
    Date.parse(observedAt) - gatewaySilenceThresholdMinutes * 60_000
  ).toISOString()
}

function deriveGatewayActivity({
  lastConnectedAt,
  lastDisconnectedAt,
  observedAt,
}: {
  lastConnectedAt: string | null
  lastDisconnectedAt: string | null
  observedAt: string
}): GatewayActivity {
  if (!lastConnectedAt) return 'never'
  if (!lastDisconnectedAt || lastDisconnectedAt <= lastConnectedAt) {
    return 'receiving'
  }

  return lastDisconnectedAt < gatewaySilenceStartedAt(observedAt)
    ? 'quiet'
    : 'receiving'
}

function skipped(reason: IngestionSkipReason) {
  return { outcome: 'skipped' as const, reason }
}

export {
  backfillPageLimit,
  backfillPageSize,
  backfillStallThresholdMinutes,
  bookmarkReactionEmoji,
  deriveGatewayActivity,
  discordHistoryBeginningSnowflake,
  gatewaySilenceThresholdMinutes,
  skipped,
}
export type {
  BackfilledMessage,
  FetchChannelHistory,
  GatewayActivity,
  IngestionSkipReason,
}
