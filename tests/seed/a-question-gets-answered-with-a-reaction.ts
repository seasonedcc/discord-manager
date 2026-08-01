import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function aQuestionGetsAnsweredWithAReaction({
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
  const engineering = requireSeeded(channels, 'engineering', 'channel')
  const omar = requireSeeded(members, 'omar', 'member')
  const priya = requireSeeded(members, 'priya', 'member')

  const asked = await feed.postMessage({
    author: omar,
    channel: engineering,
    content:
      'Shipping the release notes as they stand — shout if that is wrong.',
    discordCreatedAt: clock.at(20),
  })

  await feed.reactToMessage({ emoji: '👍', message: asked, reactor: owner })
  await feed.reactToMessage({ emoji: '👀', message: asked, reactor: priya })

  const noted = await feed.postMessage({
    author: priya,
    channel: engineering,
    content: 'The runbook now covers the extra migration step.',
    discordCreatedAt: clock.at(21),
  })

  await feed.reactToMessage({ emoji: '🎉', message: noted, reactor: omar })

  return {
    answeredByReacting: asked,
    cheeredByATeammate: noted,
    cheering: omar,
    watching: priya,
  }
}

export { aQuestionGetsAnsweredWithAReaction }
