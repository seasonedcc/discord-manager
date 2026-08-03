import {
  type Clock,
  readTheStoreInstant,
  waitForTheStoreClockToTick,
} from './clock'
import { type SeededChannel, type SeededMember, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function theBotPostsAndSomebodyAnswers({
  bot,
  channels,
  clock,
  members,
  owner,
}: {
  bot: SeededMember
  channels: Record<string, SeededChannel>
  clock: Clock
  members: Record<string, SeededMember>
  owner: SeededMember
}) {
  const engineering = requireSeeded(channels, 'engineering', 'channel')
  const maya = requireSeeded(members, 'maya', 'member')
  const priya = requireSeeded(members, 'priya', 'member')

  const recordedBefore = await readTheStoreInstant()

  await waitForTheStoreClockToTick()

  const posted = await feed.postMessage({
    author: bot,
    channel: engineering,
    content: 'Reminder: the deploy checklist lives in the handbook now.',
    discordCreatedAt: clock.at(16),
  })

  const answer = await feed.postMessage({
    author: priya,
    channel: engineering,
    content: 'Got it — I will fix the runbook link too.',
    discordCreatedAt: clock.at(16.2),
    mentioning: [bot],
  })

  const request = await feed.postMessage({
    author: maya,
    channel: engineering,
    content: `<@${bot.discordUserId}> can you put that in #announcements as well?`,
    discordCreatedAt: clock.at(16.4),
  })

  const suppressedAnswer = await feed.postMessage({
    author: maya,
    channel: engineering,
    content: 'Never mind, I found it.',
    discordCreatedAt: clock.at(16.6),
  })

  const followUp = await feed.postMessage({
    author: bot,
    channel: engineering,
    content: 'Adding the rollback steps to that checklist as well.',
    discordCreatedAt: clock.at(16.8),
    mentioning: [bot],
  })

  const noteToSelf = await feed.postMessage({
    author: owner,
    channel: engineering,
    content: `<@${owner.discordUserId}> circle back on the runbook link tomorrow`,
    discordCreatedAt: clock.at(17),
  })

  const recordedAfter = await readTheStoreInstant()

  await waitForTheStoreClockToTick()

  return {
    answer,
    followUp,
    noteToSelf,
    posted,
    recordedAfter,
    recordedBefore,
    request,
    suppressedAnswer,
  }
}

export { theBotPostsAndSomebodyAnswers }
