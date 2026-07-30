import type { RegisteredJob } from '~/framework/scheduler.server'
import {
  backfillChannel,
  backfillIngestedChannels,
  beatGatewayHeartbeat,
} from './ingestion.server'

const jobs: RegisteredJob[] = [
  backfillChannel,
  backfillIngestedChannels,
  beatGatewayHeartbeat,
]

export { jobs }
