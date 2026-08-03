import assert from 'node:assert/strict'
import { openMcpSession } from './mcp-client'
import { fixtures } from './seed'
import { test } from './spec'

type Digest = {
  messages: {
    channelName: string
    content: string
    messageId: string
  }[]
  truncated: boolean
}

type Activity = {
  activity: {
    mentions: { count: number; newestAt: string | null }
    messages: { count: number; newestAt: string | null }
  }
}

test('an answer to your bot waits in your mentions', async () => {
  const { botAnswers, channels, clock } = fixtures()
  const session = await openMcpSession()

  const digest = await session.call<Digest>('mentions_list', {
    since: clock.at(16),
  })
  const answering = (messageId: string) =>
    digest.messages.filter((message) => message.messageId === messageId)

  const [replied] = answering(botAnswers.answer.id)

  assert.equal(answering(botAnswers.answer.id).length, 1)
  assert.equal(replied.content, botAnswers.answer.content)
  assert.equal(replied.channelName, channels.engineering.name)

  const [asked] = answering(botAnswers.request.id)

  assert.equal(answering(botAnswers.request.id).length, 1)
  assert.equal(asked.content, botAnswers.request.content)

  assert.equal(answering(botAnswers.posted.id).length, 0)
  assert.equal(answering(botAnswers.suppressedAnswer.id).length, 0)
  assert.equal(answering(botAnswers.followUp.id).length, 0)
  assert.equal(answering(botAnswers.noteToSelf.id).length, 0)

  const openedOn = await session.call<Activity>('activity_since', {
    since: botAnswers.recordedBefore,
  })
  const closedOn = await session.call<Activity>('activity_since', {
    since: botAnswers.recordedAfter,
  })

  assert.equal(
    openedOn.activity.messages.count - closedOn.activity.messages.count,
    6
  )
  assert.equal(
    openedOn.activity.mentions.count - closedOn.activity.mentions.count,
    2
  )
})
