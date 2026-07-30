import {
  catchUpSinceSchema,
  listMentionsSchema,
} from '~/business/digests.common'
import { catchUpSince, listMentions } from '~/business/digests.server'
import type { McpTool } from '~/mcp/tool'

const digestsTools: McpTool[] = [
  {
    name: 'messages_catch_up',
    description:
      'Read everything posted since a moment in time, across the whole server or in one channel, with a jump link per message.',
    inputSchema: catchUpSinceSchema,
    wraps: ['digests.catchUpSince'],
    execute: (input, context) => catchUpSince(input, context),
  },
  {
    name: 'mentions_list',
    description:
      'Read the messages that mention you since a moment in time, so nothing addressed to you goes unanswered.',
    inputSchema: listMentionsSchema,
    wraps: ['digests.listMentions'],
    execute: (input, context) => listMentions(input, context),
  },
]

export { digestsTools }
