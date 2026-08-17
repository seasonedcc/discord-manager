import { feed } from './feed'

async function discordKeepsAChannelOutOfTheBotsReach() {
  const channel = await feed.observeChannel({
    category: 'Company',
    name: 'leadership',
    position: 2,
    topic: 'Where the leads settle things between themselves',
  })

  const run = await feed.backfillChannel({
    channel,
    discordDeniesAccess: true,
    history: [],
  })

  return { channel, run }
}

export { discordKeepsAChannelOutOfTheBotsReach }
