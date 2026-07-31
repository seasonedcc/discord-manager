import { activitySinceSchema } from '~/business/activity.common'
import { readActivitySince } from '~/business/activity.server'
import type { McpTool } from '~/mcp/tool'

const activityTools: McpTool[] = [
  {
    name: 'activity_since',
    description:
      "Check whether the store has recorded anything new after an instant — counts and newest timestamps for new messages, mentions of you, and bookmark additions, with no message content. Built for cheap polling: every timestamp is on the store's own clock and the cutoff is strictly after `since`, so passing back the largest newest timestamp you saw keeps answering zeros until something genuinely new arrives — including history arriving late through a backfill. When a count comes back positive, read that stream with messages_catch_up, mentions_list, or bookmarks_list, each with its own cursor.",
    inputSchema: activitySinceSchema,
    wraps: ['activity.readActivitySince'],
    execute: (input, context) => readActivitySince(input, context),
  },
]

export { activityTools }
