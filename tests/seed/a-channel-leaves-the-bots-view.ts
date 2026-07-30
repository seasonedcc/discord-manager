import { feed } from './feed'

async function aChannelLeavesTheBotsView() {
  const retiredStandup = await feed.observeChannel({
    category: 'Teams',
    name: 'retired-standup',
    position: 2,
    topic: 'The standup that moved to email',
  })

  return { retiredStandup: await feed.loseChannel(retiredStandup) }
}

export { aChannelLeavesTheBotsView }
