import { activitySinceSchema } from '~/business/activity.common'
import { readActivitySince } from '~/business/activity.server'
import type { McpTool } from '~/mcp/tool'

const activityTools: McpTool[] = [
  {
    name: 'activity_since',
    description:
      'Check whether anything happened after an instant — counts and newest timestamps for new messages, mentions of you, and bookmark additions, with no message content. Built for cheap polling: the cutoff is strictly after `since`, so passing back the newest timestamp you saw keeps answering zeros until something genuinely new arrives. When a count comes back positive, read that stream with messages_catch_up, mentions_list, or bookmarks_list.',
    inputSchema: activitySinceSchema,
    wraps: ['activity.readActivitySince'],
    execute: (input, context) => readActivitySince(input, context),
  },
]

export { activityTools }
