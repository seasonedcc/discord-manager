import { makeTypedEnv } from 'make-typed-env'
import { camelKeys } from 'string-ts'
import { z } from 'zod'

const loopbackHostnames = ['localhost', '127.0.0.1', '[::1]']

function reachesDiscordSafely(value: string) {
  if (!URL.canParse(value)) return false

  const { hostname, protocol } = new URL(value)

  if (protocol === 'https:') return true

  return protocol === 'http:' && loopbackHostnames.includes(hostname)
}

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_PATH: z.string().default('./data/discord-manager.db'),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_OWNER_USER_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
  DISCORD_API_BASE_URL: z
    .url()
    .refine(reachesDiscordSafely, {
      error:
        'DISCORD_API_BASE_URL must be an https URL, or http on localhost for a local test double. Leave it unset to talk to Discord itself.',
    })
    .default('https://discord.com/api'),
})

const getEnvironment = makeTypedEnv(environmentSchema, { transform: camelKeys })

const env = () => getEnvironment(process.env)

function requireEnvironment() {
  try {
    return env()
  } catch {
    console.error(
      'Discord Manager cannot start without DISCORD_BOT_TOKEN, DISCORD_OWNER_USER_ID and DISCORD_GUILD_ID. Copy .env.example to .env and fill those three in.'
    )
    process.exit(1)
  }
}

export { env, environmentSchema, requireEnvironment }
