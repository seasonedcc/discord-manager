function refusalForNonNumericIds({
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

  const refused = configured.filter(({ value }) => !/^\d+$/.test(value))

  if (refused.length === 0) return undefined

  const holding = refused
    .map(({ name, value }) => `${name} is set to "${value}"`)
    .join(' and ')
  const fix = refused.map(({ example }) => example).join(' and ')

  return `This seed builds real Discord message links, so it only runs when DISCORD_GUILD_ID and DISCORD_OWNER_USER_ID hold digits, but ${holding}. Put made-up digits in .env — ${fix} — then seed it. Nothing was written.`
}

export { refusalForNonNumericIds }
