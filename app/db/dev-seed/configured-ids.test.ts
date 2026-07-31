import { refusalForNonNumericIds } from '~/db/dev-seed/configured-ids'
import { describe, expect, it } from '~/test/prelude'

describe('refusalForNonNumericIds', () => {
  it('accepts the snowflakes a real Discord server hands out', () => {
    const refusal = refusalForNonNumericIds({
      guildId: '1400000000000000001',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toBeUndefined()
  })

  it('accepts any run of digits, so no real id is ever refused', () => {
    const refusal = refusalForNonNumericIds({
      guildId: '7',
      ownerUserId: '99999999999999999999',
    })

    expect(refusal).toBeUndefined()
  })

  it('refuses a guild id that is not digits, naming it and what it holds', () => {
    const refusal = refusalForNonNumericIds({
      guildId: 'demo',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toContain('DISCORD_GUILD_ID is set to "demo"')
    expect(refusal).not.toContain('DISCORD_OWNER_USER_ID is set to')
  })

  it('offers made-up digits to put in .env as the concrete fix', () => {
    const refusal = refusalForNonNumericIds({
      guildId: 'demo',
      ownerUserId: '1400000000000000002',
    })

    expect(refusal).toContain(
      'Put made-up digits in .env — DISCORD_GUILD_ID=123456789012345678 — then seed it.'
    )
    expect(refusal).toContain('Nothing was written.')
  })

  it('names both ids when both are placeholders', () => {
    const refusal = refusalForNonNumericIds({
      guildId: 'demo',
      ownerUserId: 'demo',
    })

    expect(refusal).toBe(
      'This seed builds real Discord message links, so it only runs when DISCORD_GUILD_ID and DISCORD_OWNER_USER_ID hold digits, but DISCORD_GUILD_ID is set to "demo" and DISCORD_OWNER_USER_ID is set to "demo". Put made-up digits in .env — DISCORD_GUILD_ID=123456789012345678 and DISCORD_OWNER_USER_ID=987654321098765432 — then seed it. Nothing was written.'
    )
  })

  it('refuses an owner user id carrying a snowflake with stray punctuation', () => {
    const refusal = refusalForNonNumericIds({
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
