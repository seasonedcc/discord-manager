import { makeTypedEnv } from 'make-typed-env'
import { camelKeys } from 'string-ts'
import { z } from 'zod'

const environmentSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  DATABASE_PATH: z.string().default('./data/discord-manager.db'),
})

const getEnvironment = makeTypedEnv(environmentSchema, { transform: camelKeys })

const env = () => getEnvironment(process.env)

export { env, environmentSchema }
