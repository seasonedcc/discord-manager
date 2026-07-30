import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function aThreadArchivesWhileTheBotIsAway({
  channels,
  clock,
  members,
}: {
  channels: Record<string, SeededChannel>
  clock: Clock
  members: Record<string, SeededMember>
}) {
  const releaseThread = requireSeeded(channels, 'releaseThread', 'channel')
  const maya = requireSeeded(members, 'maya', 'member')

  const hotfixThread = await feed.observeChannel({
    category: 'Teams',
    isThread: true,
    name: 'hotfix-thursday',
  })

  await feed.postMessage({
    author: maya,
    channel: hotfixThread,
    content: 'Rolling the hotfix out now.',
    discordCreatedAt: clock.at(20),
  })

  await feed.disconnectGateway()

  const stillActive = [releaseThread.discordChannelId]
  const finalSweep = await feed.reconnectGateway({
    activeThreadDiscordChannelIds: stillActive,
    walkingTheHistoryOf: [
      {
        channel: hotfixThread,
        history: [
          feed.draftHistory({
            author: maya,
            content: 'Hotfix is out — nothing left to do here.',
            discordCreatedAt: clock.at(21),
          }),
        ],
      },
    ],
  })

  const [saidWhileTheBotWasAway] = finalSweep.messages

  if (!saidWhileTheBotWasAway) {
    throw new Error(
      'The final sweep of the archived thread brought back no message'
    )
  }

  const laterReconnect = await feed.reconnectGateway({
    activeThreadDiscordChannelIds: stillActive,
  })

  return {
    finalSweep,
    hotfixThread,
    laterReconnect,
    saidWhileTheBotWasAway,
  }
}

export { aThreadArchivesWhileTheBotIsAway }
