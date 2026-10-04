// Nobody at the keyboard, and the off switch.

import { expect, mock, test } from 'claude-code/testing'
import { away, disk, person, shell } from './stand-ins'

/** /migration-guard as the person would type it, or as something else would send it. */
const slash = (args: string, kind: 'composer' | 'sdk' = 'composer') => ({
  command: 'migration-guard',
  args,
  origin: kind === 'composer' ? { kind: 'composer' as const } : { kind: 'sdk' as const },
  presentation: { isFullscreen: false, columns: 120 },
})

// Found live: in VS Code an unanswered question answered itself "Yes" after 30 seconds.
test('a question that answered itself while nobody was there blocks the change', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
  const asked: string[] = []
  const wrote: string[] = []
  away(on, asked)
  disk(on, wrote)

  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/0042_cleanup.sql', content: 'DROP TABLE users;' })
  const history = (await $.command.run(slash(''))).text ?? ''

  expect(asked.length).toBe(1)
  expect(wrote).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('no confirmation')
  expect(history).toContain('blocked (nobody answered)')
})

test('even if the dialog picked an answer by itself with no marker, the first option is No', async ($, on) => {
  const wrote: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0] as { question: string; options: { label: string }[] }
    return { result: { questions: e.questions, answers: { [q.question]: q.options[0]?.label ?? '' } } }
  })
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/0042_cleanup.sql', content: 'DROP TABLE users;' })

  expect(wrote).toEqual([])
})

test('every option says what it does', async ($, on) => {
  let options: { label: string; description?: string }[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0] as { question: string; options: { label: string; description?: string }[] }
    options = q.options
    return { result: { questions: e.questions, answers: { [q.question]: 'No' } } }
  })
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'CREATE TABLE a (id int);' })

  expect(options.map((o) => o.label)).toEqual(['No', 'Yes', 'Yes for this file', 'Yes to all files, 15 min'])
  expect(options.every((o) => (o.description ?? '').length > 10)).toBe(true)
})

test('takes what the person typed instead of picking an option', async ($, on) => {
  const wrote: string[] = []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => ({ result: { questions: e.questions, answers: {}, response: 'make a new migration instead' } }))
  disk(on, wrote)

  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })

  expect(wrote).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('make a new migration instead')
})

test('/migration-guard off lets changes through until /migration-guard on, and still writes them down', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
  const asked: string[] = []
  const wrote: string[] = []
  const ran: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)
  shell(on, ran)

  const off = await $.command.run(slash('off'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })
  await $.tool.call({ tool: 'Bash', command: 'npm run migration:run' })
  const whileOff = (await $.command.run(slash(''))).text ?? ''
  await $.command.run(slash('on'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/002.sql', content: 'DROP TABLE b;' })

  expect(off.text).toContain('The guard is off until you turn it back on')
  expect(wrote).toEqual(['/repo/migrations/001.sql'])
  expect(ran).toEqual(['npm run migration:run'])
  expect(whileOff).toContain('The guard is off until you type /migration-guard on.')
  expect(whileOff).toContain('went through (guard was off)')
  expect(asked.length).toBe(1) // only after it was back on
})

test('/migration-guard off 30 turns itself back on after 30 minutes', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const asked: string[] = []
  person(on, 'No', asked)
  disk(on, [])

  await $.command.run(slash('off 30'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })
  expect(asked.length).toBe(0)

  await clock.advance(30 * 60_000 + 1)
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/002.sql', content: 'DROP TABLE b;' })
  expect(asked.length).toBe(1)
})

test('only the person can turn it off: anything else is refused', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  person(on, 'No', asked)
  disk(on, [])

  const tried = await $.command.run(slash('off', 'sdk'))
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })

  expect(tried.text).toContain('Only you can turn the guard off')
  expect(asked.length).toBe(1)
})

test('mode off in /config never asks', { options: { mode: 'off' } }, async ($, on) => {
  mock.store(on)
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })
  const text = (await $.command.run(slash(''))).text ?? ''

  expect(asked).toEqual([])
  expect(wrote).toEqual(['/repo/migrations/001.sql'])
  expect(text).toContain('mode: off in /config')
})
