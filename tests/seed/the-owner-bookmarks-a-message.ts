import { type SeededMember, type SeededMessage, feed } from './feed'
import { requireSeeded } from './prerequisites'

async function theOwnerBookmarksAMessage({
  alert,
  members,
  messages,
  owner,
}: {
  alert: SeededMessage
  members: Record<string, SeededMember>
  messages: Record<string, SeededMessage>
  owner: SeededMember
}) {
  const corrected = requireSeeded(messages, 'corrected', 'message')
  const mention = requireSeeded(messages, 'mention', 'message')
  const offsite = requireSeeded(messages, 'offsite', 'message')
  const maya = requireSeeded(members, 'maya', 'member')

  await feed.reactToMessage({ emoji: '🔖', message: offsite, reactor: owner })
  await feed.reactToMessage({ emoji: '🔖', message: alert, reactor: owner })
  await feed.reactToMessage({ emoji: '🔖', message: corrected, reactor: maya })
  await feed.reactToMessage({ emoji: '❤️', message: mention, reactor: owner })

  return {
    bookmarked: offsite,
    bookmarkedAlert: alert,
    reactedByATeammate: corrected,
    reactedWithAnotherEmoji: mention,
  }
}

export { theOwnerBookmarksAMessage }
