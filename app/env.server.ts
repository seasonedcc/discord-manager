import { makeTypedEnv } from 'make-typed-env'
import { camelKeys } from 'string-ts'
import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_PATH: z.string().default('./data/discord-manager.db'),
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_OWNER_USER_ID: z.string().min(1),
  DISCORD_GUILD_ID: z.string().min(1),
})

const getEnvironment = makeTypedEnv(environmentSchema, { transform: camelKeys })

const env = () => getEnvironment(process.env)

export { env, environmentSchema }
