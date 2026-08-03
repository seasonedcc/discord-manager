import { activitySinceSchema } from '~/business/activity.common'
import { readActivitySince } from '~/business/activity.server'
import type { McpTool } from '~/mcp/tool'

const activityTools: McpTool[] = [
  {
    name: 'activity_since',
    description:
      "Check whether the store has recorded anything new after an instant — counts and newest timestamps for new messages, pings of you or of your bot, and bookmark additions, with no message content. It counts a ping by the same rule mentions_list reads by: someone naming you or the bot you post through, with no message ever pinging its own author. So answers to what you posted through messages_send raise the count too. Every timestamp is on the store's own clock and the cutoff is strictly after `since`, so passing back the largest newest timestamp you saw keeps answering zeros until something genuinely new arrives — including history arriving late through a backfill. It answers at once, which is all a cheap poll needs; pass `waitSeconds` to hold the call open for up to 55 seconds instead, coming back within about a second of anything landing, which is how a standing watch notices a message rather than spending a turn on every interval. When a count comes back positive, read that stream with messages_catch_up, mentions_list, or bookmarks_list, each with its own cursor.",
    inputSchema: activitySinceSchema,
    wraps: ['activity.readActivitySince'],
    execute: (input, context) => readActivitySince(input, context),
  },
]

export { activityTools }
