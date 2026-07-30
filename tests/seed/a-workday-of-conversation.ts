import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function aWorkdayOfConversation({
  channels,
  clock,
  members,
  owner,
}: {
  channels: Record<string, SeededChannel>
  clock: Clock
  members: Record<string, SeededMember>
  owner: SeededMember
}) {
  const announcements = requireSeeded(channels, 'announcements', 'channel')
  const engineering = requireSeeded(channels, 'engineering', 'channel')
  const maya = requireSeeded(members, 'maya', 'member')
  const omar = requireSeeded(members, 'omar', 'member')

  const offsite = await feed.postMessage({
    author: maya,
    channel: announcements,
    content: 'The team offsite is booked — the agenda is in the handbook.',
    discordCreatedAt: clock.at(10),
  })

  const mention = await feed.postMessage({
    author: omar,
    channel: engineering,
    content: `<@${owner.discordUserId}> can you review the deploy checklist today?`,
    discordCreatedAt: clock.at(11),
  })

  const corrected = await feed.editMessage(
    await feed.postMessage({
      author: maya,
      channel: engineering,
      content: 'Deploys are frozen until Thursday.',
      discordCreatedAt: clock.at(12),
    }),
    'Deploys are frozen until Friday.'
  )

  const withdrawn = await feed.deleteMessage(
    await feed.postMessage({
      author: omar,
      channel: announcements,
      content: 'Ignore my last note about the offsite.',
      discordCreatedAt: clock.at(13),
    })
  )

  return { corrected, mention, offsite, withdrawn }
}

export { aWorkdayOfConversation }
