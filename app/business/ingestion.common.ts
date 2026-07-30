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

const gatewayHeartbeatIntervalMinutes = 1

// A dropped shard reconnects well inside five minutes, and the daemon writes a
// heartbeat every minute, so five minutes of silence means nothing is bringing
// the link back on its own — or the daemon itself is gone.
const gatewaySilenceThresholdMinutes = 5

function gatewaySilenceStartedAt(observedAt: string) {
  return new Date(
    Date.parse(observedAt) - gatewaySilenceThresholdMinutes * 60_000
  ).toISOString()
}

function deriveGatewayActivity({
  lastAliveAt,
  lastDisconnectedAt,
  observedAt,
}: {
  lastAliveAt: string | null
  lastDisconnectedAt: string | null
  observedAt: string
}): GatewayActivity {
  if (!lastAliveAt) return 'never'

  const silenceStartedAt = gatewaySilenceStartedAt(observedAt)
  const newestSignal =
    lastDisconnectedAt && lastDisconnectedAt > lastAliveAt
      ? lastDisconnectedAt
      : lastAliveAt

  return newestSignal < silenceStartedAt ? 'quiet' : 'receiving'
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
  gatewayHeartbeatIntervalMinutes,
  gatewaySilenceThresholdMinutes,
  skipped,
}
export type {
  BackfilledMessage,
  FetchChannelHistory,
  GatewayActivity,
  IngestionSkipReason,
}
