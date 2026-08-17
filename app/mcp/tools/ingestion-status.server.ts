import { readIngestionStatusSchema } from '~/business/ingestion-status.common'
import { readIngestionStatus } from '~/business/ingestion-status.server'
import type { McpTool } from '~/mcp/tool'

const ingestionStatusTools: McpTool[] = [
  {
    name: 'ingestion_status',
    description:
      'Check whether the bot is still receiving events from Discord and how far its channel history backfills have got. Channels Discord will not let the bot read come back under `unavailableChannelNames` with a status of unavailable — a permission boundary to mention once, not a fault to warn about — while `failedChannelNames` names the backfills that genuinely stopped short and are worth acting on.',
    inputSchema: readIngestionStatusSchema,
    wraps: ['ingestion-status.readIngestionStatus'],
    execute: (input, context) => readIngestionStatus(input, context),
  },
]

export { ingestionStatusTools }
