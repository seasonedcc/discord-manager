import { type ServerResponse, createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { recordToolCall } from './coverage/gate'
import { nextDiscordId } from './discord-ids'

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..'
)

const serverEnvironment = {
  DATABASE_PATH: path.join(repositoryRoot, 'tests', '.artifacts', 'e2e.db'),
  DISCORD_BOT_TOKEN: 'end-to-end-bot-token',
  DISCORD_GUILD_ID: '1400000000000000001',
  DISCORD_OWNER_USER_ID: '1400000000000000002',
}

const channelMessagesPath = /^\/v10\/channels\/(\d{17,20})\/messages$/

type RecordedSend = {
  content: string
  discordChannelId: string
  discordMessageId: string
  replyToDiscordMessageId: string | null
}

function answer(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function startDiscordDouble() {
  const sends: RecordedSend[] = []
  const refusedChannelIds = new Set<string>()

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []

    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const route =
        request.method === 'POST'
          ? (request.url ?? '').match(channelMessagesPath)
          : null

      if (!route) {
        answer(response, 404, {
          message: `The Discord double serves no ${request.method} ${request.url}`,
          code: 0,
        })

        return
      }

      const discordChannelId = route[1]

      if (refusedChannelIds.has(discordChannelId)) {
        answer(response, 403, { message: 'Missing Permissions', code: 50013 })

        return
      }

      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        content: string
        message_reference?: { message_id: string }
      }
      const discordMessageId = nextDiscordId()

      sends.push({
        content: body.content,
        discordChannelId,
        discordMessageId,
        replyToDiscordMessageId: body.message_reference?.message_id ?? null,
      })

      answer(response, 200, {
        id: discordMessageId,
        channel_id: discordChannelId,
        content: body.content,
      })
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    refuseSendsTo(discordChannelId: string) {
      refusedChannelIds.add(discordChannelId)
    },
    sends,
    async stop() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}

type ToolErrors = {
  errors: { message: string; name: string; path: string[] }[]
}

type McpSession = {
  call: <Payload>(
    name: string,
    input?: Record<string, unknown>
  ) => Promise<Payload>
  callExpectingRefusal: (
    name: string,
    input?: Record<string, unknown>
  ) => Promise<ToolErrors>
  close: () => Promise<void>
  discord: Awaited<ReturnType<typeof startDiscordDouble>>
}

const openSessions = new Set<McpSession>()

async function openMcpSession() {
  const discord = await startDiscordDouble()
  const transport = new StdioClientTransport({
    args: ['run', 'mcp'],
    command: 'pnpm',
    cwd: repositoryRoot,
    env: {
      ...getDefaultEnvironment(),
      ...serverEnvironment,
      DISCORD_API_BASE_URL: discord.baseUrl,
    },
    stderr: 'inherit',
  })
  const client = new Client({
    name: 'discord-manager-end-to-end',
    version: '0.1.0',
  })

  await client.connect(transport)

  async function readToolResult(name: string, input: Record<string, unknown>) {
    const result = await client.callTool({ arguments: input, name })

    recordToolCall(name)

    const content = result.content as { text?: string }[]
    const text = content.map((part) => part.text ?? '').join('')

    return { isError: result.isError === true, payload: JSON.parse(text), text }
  }

  const session: McpSession = {
    async call<Payload>(name: string, input: Record<string, unknown> = {}) {
      const { isError, payload, text } = await readToolResult(name, input)

      if (isError) {
        throw new Error(`The tool ${name} answered with an error: ${text}`)
      }

      return payload as Payload
    },
    async callExpectingRefusal(
      name: string,
      input: Record<string, unknown> = {}
    ) {
      const { isError, payload, text } = await readToolResult(name, input)

      if (!isError) {
        throw new Error(
          `The tool ${name} was expected to refuse, but answered: ${text}`
        )
      }

      return payload as ToolErrors
    },
    discord,
    async close() {
      openSessions.delete(session)
      await client.close()
      await discord.stop()
    },
  }

  openSessions.add(session)

  return session
}

async function closeOpenSessions() {
  for (const session of [...openSessions]) await session.close()
}

export { closeOpenSessions, openMcpSession, repositoryRoot, serverEnvironment }
