import type { Clock } from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function historyArrivesThroughABackfill({
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
  const channel = requireSeeded(channels, 'announcements', 'channel')
  const maya = requireSeeded(members, 'maya', 'member')
  const priya = requireSeeded(members, 'priya', 'member')
  const preview = {
    description: 'Every decision the team agreed to keep, in one place.',
    url: 'https://handbook.example.test/decisions',
  }
  const welcome = feed.draftHistory({
    author: maya,
    content: 'This server replaces the old group chat.',
    discordCreatedAt: clock.at(1),
    reactedTo: [
      { emoji: '🎉', reactors: [priya] },
      { emoji: '👍', reactors: [owner, priya] },
    ],
  })
  const handbookNote = feed.draftHistory({
    author: priya,
    content: 'Everything worth keeping is in the handbook.',
    discordCreatedAt: clock.at(2),
    embeds: [preview],
  })
  const keptForLater = feed.draftHistory({
    author: maya,
    content: 'The onboarding checklist everyone new should read first.',
    discordCreatedAt: clock.at(3),
    reactedTo: [{ emoji: '🔖', reactors: [owner] }],
  })
  const reactedToOutOfSight = feed.draftHistory({
    author: priya,
    content: 'The retro notes are up — react if you want a follow-up.',
    discordCreatedAt: clock.at(4),
    reactorsDiscordRefusedToList: true,
  })
  const answeredTheWelcome = feed.draftHistory({
    answering: { channel, message: welcome },
    author: priya,
    content: 'Good riddance to that group chat.',
    discordCreatedAt: clock.at(4.5),
  })

  const walked = await feed.backfillChannel({
    channel,
    history: [
      welcome,
      handbookNote,
      keptForLater,
      reactedToOutOfSight,
      answeredTheWelcome,
    ],
  })

  return {
    ...walked,
    answeredInHistory: { answered: welcome, message: answeredTheWelcome },
    reactionsUnread: { channel, message: reactedToOutOfSight },
    bookmarkedInDiscord: {
      message: keptForLater,
      reactions: [{ emoji: '🔖', count: 1, ownerReacted: true }],
    },
    linkPreview: {
      message: handbookNote,
      text: `${preview.url}\n${preview.description}`,
    },
    welcomed: {
      message: welcome,
      reactions: [
        { emoji: '🎉', count: 1, ownerReacted: false },
        { emoji: '👍', count: 2, ownerReacted: true },
      ],
    },
  }
}

export { historyArrivesThroughABackfill }
