import type { McpTool } from '~/mcp/tool'
import { activityTools } from '~/mcp/tools/activity.server'
import { bookmarksTools } from '~/mcp/tools/bookmarks.server'
import { channelsTools } from '~/mcp/tools/channels.server'
import { digestsTools } from '~/mcp/tools/digests.server'
import { ingestionStatusTools } from '~/mcp/tools/ingestion-status.server'
import { membersTools } from '~/mcp/tools/members.server'
import { messagesTools } from '~/mcp/tools/messages.server'
import { sendingTools } from '~/mcp/tools/sending.server'
import { threadsTools } from '~/mcp/tools/threads.server'

const registeredTools: McpTool[] = [
  ...activityTools,
  ...bookmarksTools,
  ...channelsTools,
  ...digestsTools,
  ...ingestionStatusTools,
  ...membersTools,
  ...messagesTools,
  ...sendingTools,
  ...threadsTools,
]

export { registeredTools }
