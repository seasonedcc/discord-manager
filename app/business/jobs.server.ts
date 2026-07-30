import type { RegisteredJob } from '~/framework/scheduler.server'
import { backfillChannel, backfillIngestedChannels } from './ingestion.server'

const jobs: RegisteredJob[] = [backfillChannel, backfillIngestedChannels]

export { jobs }
