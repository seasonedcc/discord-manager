import type { McpTool } from '~/mcp/tool'
import { bookmarksTools } from '~/mcp/tools/bookmarks.server'
import { channelsTools } from '~/mcp/tools/channels.server'
import { digestsTools } from '~/mcp/tools/digests.server'
import { ingestionStatusTools } from '~/mcp/tools/ingestion-status.server'
import { sendingTools } from '~/mcp/tools/sending.server'

const registeredTools: McpTool[] = [
  ...bookmarksTools,
  ...channelsTools,
  ...digestsTools,
  ...ingestionStatusTools,
  ...sendingTools,
]

export { registeredTools }
