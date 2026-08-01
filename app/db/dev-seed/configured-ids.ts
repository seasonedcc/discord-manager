const discordSnowflakePattern = /^\d{17,20}$/

function refusalForNonSnowflakeIds({
  guildId,
  ownerUserId,
}: {
  guildId: string
  ownerUserId: string
}) {
  const configured = [
    {
      example: 'DISCORD_GUILD_ID=123456789012345678',
      name: 'DISCORD_GUILD_ID',
      value: guildId,
    },
    {
      example: 'DISCORD_OWNER_USER_ID=987654321098765432',
      name: 'DISCORD_OWNER_USER_ID',
      value: ownerUserId,
    },
  ]

  const refused = configured.filter(
    ({ value }) => !discordSnowflakePattern.test(value)
  )

  if (refused.length === 0) return undefined

  const holding = refused
    .map(({ name, value }) => `${name} is set to "${value}"`)
    .join(' and ')
  const fix = refused.map(({ example }) => example).join(' and ')
  const madeUp = refused.length === 1 ? 'a made-up id' : 'made-up ids'

  return `This seed builds real Discord message links, so it only runs when DISCORD_GUILD_ID and DISCORD_OWNER_USER_ID hold Discord ids — 17 to 20 digits, the length Discord hands out — but ${holding}. Put ${madeUp} of that length in .env — ${fix} — then seed it. Nothing was written.`
}

export { refusalForNonSnowflakeIds }
