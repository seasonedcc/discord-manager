import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  type CallToolResult,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js'
import { type Result, serializeError } from 'composable-functions'
import { z } from 'zod'
import { ownerContext } from '~/business/auth.server'
import { registeredTools } from '~/mcp/registry.server'

const serverInfo = { name: 'discord-manager', version: '0.1.0' }

function listTools(): Tool[] {
  return registeredTools.map(({ description, inputSchema, name }) => ({
    name,
    description,
    inputSchema: z.toJSONSchema(inputSchema, {
      io: 'input',
    }) as Tool['inputSchema'],
  }))
}

function toToolResult(result: Result<unknown>): CallToolResult {
  const payload = result.success
    ? result.data
    : {
        errors: result.errors.map((error) => {
          const { message, name, path } = serializeError(error)

          return { message, name, path }
        }),
      }

  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: !result.success,
  }
}

async function callTool(
  request: { name: string; arguments?: unknown },
  context: unknown
) {
  const tool = registeredTools.find(({ name }) => name === request.name)

  if (!tool) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `No tool named "${request.name}" is registered`
    )
  }

  return toToolResult(await tool.execute(request.arguments ?? {}, context))
}

async function startMcpServer() {
  const server = new Server(serverInfo, { capabilities: { tools: {} } })

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }))

  server.setRequestHandler(CallToolRequestSchema, async ({ params }) =>
    callTool(params, ownerContext())
  )

  await server.connect(new StdioServerTransport())

  return server
}

export { callTool, listTools, startMcpServer }
