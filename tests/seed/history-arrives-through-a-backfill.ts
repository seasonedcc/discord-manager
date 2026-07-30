import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function historyArrivesThroughABackfill({
  channels,
  clock,
  members,
}: {
  channels: Record<string, SeededChannel>
  clock: Clock
  members: Record<string, SeededMember>
}) {
  const channel = requireSeeded(channels, 'announcements', 'channel')
  const maya = requireSeeded(members, 'maya', 'member')
  const priya = requireSeeded(members, 'priya', 'member')

  return await feed.backfillChannel({
    channel,
    history: [
      feed.draftHistory({
        author: maya,
        content: 'This server replaces the old group chat.',
        discordCreatedAt: clock.at(1),
      }),
      feed.draftHistory({
        author: priya,
        content: 'Everything worth keeping is in the handbook.',
        discordCreatedAt: clock.at(2),
      }),
    ],
  })
}

export { historyArrivesThroughABackfill }
