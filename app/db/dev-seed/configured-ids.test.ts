import { refusalForNonSnowflakeIds } from '~/db/dev-seed/configured-ids'
import { describe, expect, it } from '~/test/prelude'

describe('refusalForNonSnowflakeIds', () => {
  it('accepts the snowflakes a real Discord server hands out', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: '1400000000000000001',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toBeUndefined()
  })

  it('accepts every length a Discord id can carry, so no real id is ever refused', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: '12345678901234567',
      ownerUserId: '99999999999999999999',
    })

    expect(refusal).toBeUndefined()
  })

  it('refuses a guild id with fewer digits than a Discord id carries', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: '7',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toContain('DISCORD_GUILD_ID is set to "7"')
    expect(refusal).toContain('17 to 20 digits')
    expect(refusal).not.toContain('DISCORD_OWNER_USER_ID is set to')
  })

  it('refuses an owner user id with more digits than a Discord id carries', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: '1400000000000000001',
      ownerUserId: '123456789012345678901',
    })

    expect(refusal).toContain(
      'DISCORD_OWNER_USER_ID is set to "123456789012345678901"'
    )
    expect(refusal).not.toContain('DISCORD_GUILD_ID is set to')
  })

  it('refuses a guild id that is not digits, naming it and what it holds', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: 'demo',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toContain('DISCORD_GUILD_ID is set to "demo"')
    expect(refusal).not.toContain('DISCORD_OWNER_USER_ID is set to')
  })

  it('offers a made-up id of the right length to put in .env as the concrete fix', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: 'demo',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toContain(
      'Put a made-up id of that length in .env — DISCORD_GUILD_ID=123456789012345678 — then seed it.'
    )
    expect(refusal).toContain('Nothing was written.')
  })

  it('names both ids when both are placeholders', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: 'demo',
      ownerUserId: 'demo',
    })

    expect(refusal).toBe(
      'This seed builds real Discord message links, so it only runs when DISCORD_GUILD_ID and DISCORD_OWNER_USER_ID hold Discord ids — 17 to 20 digits, the length Discord hands out — but DISCORD_GUILD_ID is set to "demo" and DISCORD_OWNER_USER_ID is set to "demo". Put made-up ids of that length in .env — DISCORD_GUILD_ID=123456789012345678 and DISCORD_OWNER_USER_ID=987654321098765432 — then seed it. Nothing was written.'
    )
  })

  it('refuses an owner user id carrying a snowflake with stray punctuation', () => {
    const refusal = refusalForNonSnowflakeIds({
      guildId: '1400000000000000001',
      ownerUserId: '<@1400000000000000002>',
    })

    expect(refusal).toContain(
      'DISCORD_OWNER_USER_ID is set to "<@1400000000000000002>"'
    )
    expect(refusal).toContain(
      'DISCORD_OWNER_USER_ID=987654321098765432 — then seed it.'
    )
  })
})
