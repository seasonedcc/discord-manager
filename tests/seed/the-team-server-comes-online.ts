import { type SeededMember, feed } from './feed'

async function theTeamServerComesOnline({ bot }: { bot: SeededMember }) {
  await feed.connectGateway()
  await feed.disconnectGateway()
  await feed.connectGateway()
  await feed.identifyAsBot(bot)

  const announcements = await feed.observeChannel({
    category: 'Company',
    name: 'announcements',
    position: 0,
    topic: 'Where the whole team hears things first',
  })
  const engineering = await feed.observeChannel({
    category: 'Teams',
    name: 'engineering',
    position: 1,
    topic: 'Where the product gets built',
  })

  const lobby = await feed.observeChannel({ name: 'lobby', position: 0 })
  const releaseThread = await feed.observeChannel({
    category: 'Teams',
    isThread: true,
    name: 'friday-release',
  })

  return { announcements, engineering, lobby, releaseThread }
}

export { theTeamServerComesOnline }
