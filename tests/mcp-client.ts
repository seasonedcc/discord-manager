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
const channelMessagePath =
  /^\/v10\/channels\/(\d{17,20})\/messages\/(\d{17,20})$/
const messageReactionPath =
  /^\/v10\/channels\/(\d{17,20})\/messages\/(\d{17,20})\/reactions\/([^/]+)$/
const channelThreadsPath = /^\/v10\/channels\/(\d{17,20})\/threads$/
const messageThreadsPath =
  /^\/v10\/channels\/(\d{17,20})\/messages\/(\d{17,20})\/threads$/
const unknownMessageCode = 10008
const unknownChannelCode = 10003
const publicThreadType = 11

type RecordedSend = {
  content: string
  discordChannelId: string
  discordMessageId: string
  replyToDiscordMessageId: string | null
}

type RecordedThread = {
  anchorDiscordMessageId: string | null
  autoArchiveDuration: number
  discordThreadId: string
  name: string
  parentDiscordChannelId: string
  type: number | undefined
}

type RecordedRead = {
  discordChannelId: string
  discordMessageId: string
}

type LiveEmbed = {
  author?: { name: string }
  description?: string
  fields?: { name: string; value: string }[]
  footer?: { text: string }
  timestamp?: string
  title?: string
  url?: string
}

type LiveReaction = {
  botReacted?: boolean
  emoji: { animated?: boolean; id: string | null; name: string | null }
  reactorDiscordUserIds: string[]
  superReactorDiscordUserIds?: string[]
}

type LiveMessage = {
  attachments?: { filename: string; size: number; url: string }[]
  content?: string
  embeds?: LiveEmbed[]
  flags?: number
  reactions?: LiveReaction[]
}

function answer(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

function reactionAnswersTo({ emoji }: LiveReaction, key: string) {
  if (!emoji.id) return key === emoji.name

  return key.endsWith(`:${emoji.id}`)
}

async function startDiscordDouble() {
  const sends: RecordedSend[] = []
  const reads: RecordedRead[] = []
  const threads: RecordedThread[] = []
  const refusedChannelIds = new Set<string>()
  const refusedThreadChannelIds = new Set<string>()
  const heldMessages = new Map<string, LiveMessage>()
  const forgottenMessageIds = new Set<string>()
  const unlistableReactionMessageIds = new Set<string>()

  function serveSend(
    response: ServerResponse,
    discordChannelId: string,
    body: Buffer
  ) {
    if (refusedChannelIds.has(discordChannelId)) {
      return answer(response, 403, {
        message: 'Missing Permissions',
        code: 50013,
      })
    }

    const sent = JSON.parse(body.toString('utf8')) as {
      content: string
      message_reference?: { message_id: string }
    }
    const discordMessageId = nextDiscordId()

    sends.push({
      content: sent.content,
      discordChannelId,
      discordMessageId,
      replyToDiscordMessageId: sent.message_reference?.message_id ?? null,
    })

    answer(response, 200, {
      id: discordMessageId,
      channel_id: discordChannelId,
      content: sent.content,
    })
  }

  // Discord gives a thread anchored on a message the message's own snowflake as
  // its channel id; a thread of its own gets a fresh one.
  function serveThread(
    response: ServerResponse,
    parentDiscordChannelId: string,
    anchorDiscordMessageId: string | null,
    body: Buffer
  ) {
    if (refusedThreadChannelIds.has(parentDiscordChannelId)) {
      return answer(response, 403, {
        message: 'Missing Permissions',
        code: 50013,
      })
    }

    if (
      anchorDiscordMessageId &&
      forgottenMessageIds.has(anchorDiscordMessageId)
    ) {
      return answer(response, 404, {
        message: 'Unknown Message',
        code: unknownMessageCode,
      })
    }

    const asked = JSON.parse(body.toString('utf8')) as {
      auto_archive_duration: number
      name: string
      type?: number
    }
    const discordThreadId = anchorDiscordMessageId ?? nextDiscordId()

    threads.push({
      anchorDiscordMessageId,
      autoArchiveDuration: asked.auto_archive_duration,
      discordThreadId,
      name: asked.name,
      parentDiscordChannelId,
      type: asked.type,
    })

    answer(response, 200, {
      id: discordThreadId,
      name: asked.name,
      parent_id: parentDiscordChannelId,
      type: publicThreadType,
    })
  }

  function serveMessage(
    response: ServerResponse,
    discordChannelId: string,
    discordMessageId: string
  ) {
    reads.push({ discordChannelId, discordMessageId })

    if (forgottenMessageIds.has(discordMessageId)) {
      return answer(response, 404, {
        message: 'Unknown Message',
        code: unknownMessageCode,
      })
    }

    const held = heldMessages.get(discordMessageId)

    if (!held) {
      return answer(response, 404, {
        message: 'Unknown Channel',
        code: unknownChannelCode,
      })
    }

    answer(response, 200, {
      id: discordMessageId,
      channel_id: discordChannelId,
      content: held.content ?? '',
      attachments: held.attachments ?? [],
      embeds: held.embeds ?? [],
      flags: held.flags ?? 0,
      reactions: (held.reactions ?? []).map((reaction) => ({
        count:
          reaction.reactorDiscordUserIds.length +
          (reaction.superReactorDiscordUserIds ?? []).length,
        count_details: {
          burst: (reaction.superReactorDiscordUserIds ?? []).length,
          normal: reaction.reactorDiscordUserIds.length,
        },
        me: reaction.botReacted ?? false,
        emoji: reaction.emoji,
      })),
    })
  }

  function serveReactors(
    response: ServerResponse,
    discordMessageId: string,
    emoji: string,
    query: URLSearchParams
  ) {
    if (unlistableReactionMessageIds.has(discordMessageId)) {
      return answer(response, 403, { message: 'Missing Access', code: 50001 })
    }

    const reaction = (heldMessages.get(discordMessageId)?.reactions ?? []).find(
      (candidate) => reactionAnswersTo(candidate, emoji)
    )

    if (!reaction) {
      return answer(response, 404, {
        message: `The Discord double holds no ${emoji} reaction on message ${discordMessageId}`,
        code: 0,
      })
    }

    const reactors =
      query.get('type') === '1'
        ? (reaction.superReactorDiscordUserIds ?? [])
        : reaction.reactorDiscordUserIds
    const after = query.get('after')
    const limit = Number(query.get('limit') ?? '25')
    const resumeAt = after ? reactors.indexOf(after) : -1

    if (after && resumeAt === -1) {
      return answer(response, 400, {
        message: `The Discord double has no reactor ${after} to page after`,
        code: 0,
      })
    }

    const start = resumeAt + 1

    answer(
      response,
      200,
      reactors.slice(start, start + limit).map((id) => ({ id }))
    )
  }

  const server = createServer((request, response) => {
    const chunks: Buffer[] = []

    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const { pathname, searchParams } = new URL(
        request.url ?? '',
        'http://discord.double'
      )
      const posted =
        request.method === 'POST' ? pathname.match(channelMessagesPath) : null
      const read =
        request.method === 'GET' ? pathname.match(channelMessagePath) : null
      const reactors =
        request.method === 'GET' ? pathname.match(messageReactionPath) : null
      const threaded =
        request.method === 'POST' ? pathname.match(channelThreadsPath) : null
      const anchored =
        request.method === 'POST' ? pathname.match(messageThreadsPath) : null

      if (posted) {
        return serveSend(response, posted[1], Buffer.concat(chunks))
      }

      if (threaded) {
        return serveThread(response, threaded[1], null, Buffer.concat(chunks))
      }

      if (anchored) {
        return serveThread(
          response,
          anchored[1],
          anchored[2],
          Buffer.concat(chunks)
        )
      }

      if (read) return serveMessage(response, read[1], read[2])

      if (reactors) {
        return serveReactors(
          response,
          reactors[2],
          decodeURIComponent(reactors[3]),
          searchParams
        )
      }

      answer(response, 404, {
        message: `The Discord double serves no ${request.method} ${request.url}`,
        code: 0,
      })
    })
  })

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })

  const { port } = server.address() as AddressInfo

  return {
    acceptSendsTo(discordChannelId: string) {
      refusedChannelIds.delete(discordChannelId)
    },
    baseUrl: `http://127.0.0.1:${port}`,
    forgetsMessage(discordMessageId: string) {
      heldMessages.delete(discordMessageId)
      forgottenMessageIds.add(discordMessageId)
    },
    holdsMessage(discordMessageId: string, live: LiveMessage) {
      forgottenMessageIds.delete(discordMessageId)
      heldMessages.set(discordMessageId, live)
    },
    reads,
    refuseReactorListingsOf(discordMessageId: string) {
      unlistableReactionMessageIds.add(discordMessageId)
    },
    refuseSendsTo(discordChannelId: string) {
      refusedChannelIds.add(discordChannelId)
    },
    refuseThreadsIn(discordChannelId: string) {
      refusedThreadChannelIds.add(discordChannelId)
    },
    sends,
    threads,
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
