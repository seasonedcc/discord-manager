import { environmentSchema } from '~/env.server'
import { describe, expect, it } from '~/test/prelude'

const configured = {
  DISCORD_BOT_TOKEN: 'bot-token',
  DISCORD_GUILD_ID: '1400000000000000001',
  DISCORD_OWNER_USER_ID: '1400000000000000002',
}

describe('environmentSchema', () => {
  it('sends the bot to Discord itself when no base url is configured', () => {
    const environment = environmentSchema.parse(configured)

    expect(environment.DISCORD_API_BASE_URL).toBe('https://discord.com/api')
  })

  it('accepts a loopback base url so a local test double can stand in', () => {
    const environment = environmentSchema.parse({
      ...configured,
      DISCORD_API_BASE_URL: 'http://127.0.0.1:51234',
    })

    expect(environment.DISCORD_API_BASE_URL).toBe('http://127.0.0.1:51234')
  })

  it('refuses to send the bot token over plain http to another host', () => {
    const result = environmentSchema.safeParse({
      ...configured,
      DISCORD_API_BASE_URL: 'http://discord-proxy.example.com/api',
    })

    expect(result.success).toBe(false)
    expect(result.error?.issues[0].message).toBe(
      'DISCORD_API_BASE_URL must be an https URL, or http on localhost for a local test double. Leave it unset to talk to Discord itself.'
    )
  })

  it('refuses a base url that is not a url at all', () => {
    const result = environmentSchema.safeParse({
      ...configured,
      DISCORD_API_BASE_URL: 'discord.com/api',
    })

    expect(result.success).toBe(false)
  })
})
