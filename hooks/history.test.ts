import { expect, mock, test } from 'claude-code/testing'
import { HISTORY_LIMIT, append, asEntries, redact, render, type Entry } from './history'
import { disk, person, shell } from './stand-ins'

/** /migration-guard as the person would type it. */
const slash = (args: string) => ({ command: 'migration-guard', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 120 } })

const entry = (n: number, answer = 'Yes'): Entry => ({
  at: Date.UTC(2026, 9, 4, 12, n),
  project: '.../acme/api',
  what: 'write a migration file',
  target: `.../db/migrations/00${n}.sql`,
  risk: 'low',
  labels: [],
  answer,
})

test('masks passwords and tokens before anything is kept', () => {
  expect(redact('psql postgres://app:s3cret@db:5432/app -c "x"')).toBe('psql postgres://app:***@db:5432/app -c "x"')
  expect(redact('PGPASSWORD=s3cret psql -h db')).toBe('PGPASSWORD=*** psql -h db')
  expect(redact('mysql -u root -ps3cret app < x.sql')).toBe('mysql -u root -p*** app < x.sql')
  expect(redact('flyway -password=s3cret migrate')).toBe('flyway -password=*** migrate')
  expect(redact('liquibase --password s3cret update')).toBe('liquibase --password *** update')
  expect(redact('psql "host=db password=s3cret dbname=app"')).toBe('psql "host=db password=*** dbname=app"')
  expect(redact('API_KEY=abc DATABASE_TOKEN="x y" npm run migrate')).toBe('API_KEY=*** DATABASE_TOKEN=*** npm run migrate')
  expect(redact('npm run migration:run')).toBe('npm run migration:run')
})

test('keeps the newest entries up to the limit', () => {
  let list: Entry[] = []
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) list = append(list, entry(i % 60))
  expect(list.length).toBe(HISTORY_LIMIT)
})

test('ignores whatever else might be in the store', () => {
  expect(asEntries(undefined)).toEqual([])
  expect(asEntries('nope')).toEqual([])
  expect(asEntries([{ at: 1, answer: 'Yes' }, 'junk', null]).length).toBe(1)
})

test('shows the newest first, with a count of what was blocked', () => {
  const text = render([entry(1), entry(2, 'No'), entry(3, '"use staging"')], 20)
  const lines = text.split('\n')
  expect(lines[0]).toContain('Last 3 of 3 (2 blocked)')
  expect(lines[1]).toContain('"use staging"')
  expect(lines[3]).toContain('.../db/migrations/001.sql')
  expect(render([], 20)).toBe('Nothing asked yet.')
})

test('writes down each question and answer, and /migration-guard shows them', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: Date.UTC(2026, 9, 4, 9, 30) })
  on('session.cwd', () => ({ value: '/home/me/acme/api' }))
  person(on, ['No', 'Yes'], [])
  disk(on, [])
  shell(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/db/migrations/001.sql', content: 'DROP TABLE users;' })
  await $.tool.call({ tool: 'Bash', command: 'PGPASSWORD=s3cret psql -h db -f fix.sql' })
  const shown = await $.command.run(slash(''))

  const text = shown.text ?? ''
  expect(text).toContain('Last 2 of 2 (1 blocked)')
  expect(text).toContain('No  [high]  write a migration file: .../db/migrations/001.sql (DROP TABLE)  in .../me/acme/api')
  expect(text).toContain('PGPASSWORD=***')
  expect(text).not.toContain('s3cret')
})

test('remembers what went through under "Yes to all files" too', async ($, on) => {
  mock.store(on)
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
  person(on, ['Yes to all files, 15 min'], [])
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/010_a.sql', content: 'CREATE TABLE a (id int);' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/011_b.sql', content: 'CREATE TABLE b (id int);' })
  const text = (await $.command.run(slash(''))).text ?? ''

  expect(text).toContain('went through (yes to all files)')
  expect(text).toContain('Yes to all files, 15 min')
})

test('/migration-guard clear empties it', async ($, on) => {
  mock.store(on, { history: [entry(1)] })
  const cleared = await $.command.run(slash('clear'))
  const after = await $.command.run(slash(''))
  expect(cleared.text).toBe('History cleared.')
  expect(after.text).toBe('Nothing asked yet.')
})

test('keeps nothing when history is off', { options: { keepHistory: 'off' } }, async ($, on) => {
  const written: string[] = []
  on('store.get', () => ({ value: undefined }))
  on('store.set', (_$, e) => {
    written.push(e.key)
    return { value: undefined }
  })
  person(on, 'No', [])
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE users;' })
  const text = (await $.command.run(slash(''))).text ?? ''

  expect(text).toContain('History is off')
  expect(written).toEqual([])
})

test('the guard still works when there is no store at all', async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE users;' })

  expect(asked.length).toBe(1)
  expect(wrote).toEqual([])
})

test('says so when a pattern setting is not a valid regular expression', { options: { extraPathPattern: 'schema/(changes' } }, async ($, on) => {
  mock.store(on)
  const text = (await $.command.run(slash(''))).text ?? ''
  expect(text).toContain("extraPathPattern in /config isn't a valid regular expression, so it's ignored.")
})

// Found live: a second session kept its own copy and brought back what the first had cleared.
test("doesn't undo another session's clear, or drop its entries", async ($, on) => {
  const shared = new Map<string, unknown>() // the store both sessions see
  on('store.get', (_$, e) => ({ value: shared.get(e.key) }))
  on('store.set', (_$, e) => {
    shared.set(e.key, e.value)
    return { value: undefined }
  })
  mock.clock(on, { now: 1_000_000 })
  on('session.cwd', () => ({ value: '/repo' }))
  person(on, 'No', [])
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001.sql', content: 'DROP TABLE a;' })
  shared.set('history', []) // another session ran /migration-guard clear
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/002.sql', content: 'DROP TABLE b;' })
  expect(asEntries(shared.get('history')).map((e) => e.target)).toEqual(['/repo/migrations/002.sql'])

  shared.set('history', [...asEntries(shared.get('history')), entry(7)]) // another session wrote one
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/003.sql', content: 'DROP TABLE c;' })
  expect(asEntries(shared.get('history')).length).toBe(3)
})
