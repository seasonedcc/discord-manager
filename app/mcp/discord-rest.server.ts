import { REST } from 'discord.js'
import { env } from '~/env.server'

let discordRest: REST | undefined

function restClient() {
  discordRest ??= new REST({ api: env().discordApiBaseUrl }).setToken(
    env().discordBotToken
  )

  return discordRest
}

export { restClient }
