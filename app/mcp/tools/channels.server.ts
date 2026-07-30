import { listChannelsSchema } from '~/business/channels.common'
import { listChannels } from '~/business/channels.server'
import type { McpTool } from '~/mcp/tool'

const channelsTools: McpTool[] = [
  {
    name: 'channels_list',
    description:
      'List the channels the bot can see in your Discord server, with the name, topic, and category each one carries right now.',
    inputSchema: listChannelsSchema,
    wraps: ['channels.listChannels'],
    execute: (input, context) => listChannels(input, context),
  },
]

export { channelsTools }
