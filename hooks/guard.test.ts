import { expect, mock, test } from 'claude-code/testing'
import { classifyCommand, findDestructive, isMigrationPath } from './detect'
import { questionFor } from './question'
import { disk, person } from './stand-ins'

const labels = (text: string, skipDown = false) => findDestructive(text, { skipDown }).map((f) => f.label)
const asks = (command: string) => classifyCommand(command) !== undefined

// ------------------------------------------------------------- files

test('spots migration files across frameworks', () => {
  expect(isMigrationPath('/repo/src/database/migrations/1890-add-x.ts')).toBe(true) // TypeORM
  expect(isMigrationPath('/repo/prisma/migrations/2026_init/migration.sql')).toBe(true) // Prisma
  expect(isMigrationPath('/app/db/migrate/20260101_add_users.rb')).toBe(true) // Rails
  expect(isMigrationPath('/app/alembic/versions/abc_add_users.py')).toBe(true) // Alembic
  expect(isMigrationPath('/app/drizzle/0001_init.sql')).toBe(true) // Drizzle
  expect(isMigrationPath('/app/Migrations/20260101_AddUsers.cs')).toBe(true) // EF Core
  expect(isMigrationPath('/app/src/main/resources/db/migration/V2__drop.sql')).toBe(true) // Flyway
})

test('ignores lookalikes, docs and tests', () => {
  expect(isMigrationPath('/repo/src/modules/data-migration/service.ts')).toBe(false)
  expect(isMigrationPath('/repo/src/database/migrations/README.md')).toBe(false)
  expect(isMigrationPath('/repo/src/database/migrations/1890-x.spec.ts')).toBe(false)
  expect(isMigrationPath('/repo/CHANGELOG.md')).toBe(false)
  expect(isMigrationPath('/repo/src/migrationHelpers.ts')).toBe(false)
})

test('works with Windows and macOS paths', () => {
  expect(isMigrationPath('C:\\repo\\src\\database\\migrations\\001-add-x.ts')).toBe(true)
  expect(isMigrationPath('C:\\Users\\me\\app\\db\\migrate\\20260101_add.rb')).toBe(true)
  expect(isMigrationPath('/Users/me/app/prisma/migrations/2026_init/migration.sql')).toBe(true)
  expect(isMigrationPath('C:\\repo\\src\\modules\\data-migration\\x.ts')).toBe(false)
})

test('takes an extra path pattern from settings', () => {
  expect(isMigrationPath('/repo/schema/changes/001.sql', /schema\/changes\//)).toBe(true)
})

// --------------------------------------------------- destructive statements

test('finds the obvious destroyers', () => {
  expect(labels('DROP TABLE users;')).toEqual(['DROP TABLE'])
  expect(labels('ALTER TABLE users DROP COLUMN email;')).toEqual(['DROP COLUMN'])
  expect(labels('DROP INDEX idx_users_email;')).toEqual(['DROP INDEX'])
  expect(labels('TRUNCATE TABLE sessions;')).toEqual(['TRUNCATE'])
  expect(labels('DROP DATABASE prod;')).toEqual(['DROP DATABASE'])
  expect(labels('ALTER TABLE t ALTER COLUMN amount TYPE numeric(18,4);')).toEqual(['ALTER COLUMN TYPE'])
  expect(labels('ALTER TABLE users RENAME COLUMN email TO mail;')).toEqual(['RENAME'])
})

test('catches the sneaky forms', () => {
  expect(labels('ALTER TABLE users DROP email;')).toEqual(['DROP COLUMN']) // COLUMN is optional
  expect(labels('ALTER TABLE t DROP KEY idx_a;')).toEqual(['DROP INDEX']) // MySQL
  expect(labels('DELETE FROM users WHERE 1=1;')).toEqual(['DELETE without WHERE'])
  expect(labels('DELETE FROM users;')).toEqual(['DELETE without WHERE'])
  expect(labels('UPDATE users SET active = false;')).toEqual(['UPDATE without WHERE'])
})

test('reads ORM code and names it like the SQL it runs', () => {
  expect(labels('await queryRunner.dropColumn("users", "email")')).toEqual(['DROP COLUMN']) // TypeORM
  expect(labels('table.dropColumn("email")')).toEqual(['DROP COLUMN']) // Knex
  expect(labels('$table->dropColumn("email");')).toEqual(['DROP COLUMN']) // Laravel
  expect(labels('remove_column :users, :email')).toEqual(['DROP COLUMN']) // Rails
  expect(labels('migrations.RemoveField(model_name="user", name="email")')).toEqual(['DROP COLUMN']) // Django
  expect(labels('op.drop_column("users", "email")')).toEqual(['DROP COLUMN']) // Alembic
  expect(labels('migrationBuilder.DropColumn(name: "Email", table: "Users");')).toEqual(['DROP COLUMN']) // EF Core
  expect(labels("Schema::dropIfExists('users');")).toEqual(['DROP TABLE'])
  expect(labels('await queryRunner.clearTable("sessions")')).toEqual(['TRUNCATE'])
  expect(labels('change_column :users, :age, :string')).toEqual(['ALTER COLUMN'])
  expect(labels('db.users.drop()')).toEqual(['DROP COLLECTION'])
  expect(labels('db.users.deleteMany({})')).toEqual(['DELETE without WHERE'])
})

test('reports every destructive change, not just the first', () => {
  const found = labels('await queryRunner.dropIndex("users", "idx")\nawait queryRunner.dropTable("users")')
  expect(found).toContain('DROP INDEX')
  expect(found).toContain('DROP TABLE')
})

test('stays quiet on safe changes and comments', () => {
  expect(labels('CREATE TABLE users (id uuid primary key);')).toEqual([])
  expect(labels('DELETE FROM users WHERE id = 1;')).toEqual([])
  expect(labels('ALTER TABLE t ALTER COLUMN c DROP DEFAULT;')).toEqual([])
  expect(labels('ALTER TABLE users DROP CONSTRAINT fk_org;')).toEqual(['DROP CONSTRAINT'])
  expect(labels('-- DROP TABLE users\nSELECT 1;')).toEqual([])
  expect(labels('/* DROP TABLE users */ SELECT 1;')).toEqual([])
})

test('reads only the forward half of a migration', () => {
  const migration = [
    'export class AddX {',
    '  async up(q) { await q.query(`ALTER TABLE "users" DROP COLUMN "email"`) }',
    '  async down(q) { await q.query(`DROP INDEX "idx_users_email"`) }',
    '}',
  ].join('\n')
  expect(labels(migration, true)).toEqual(['DROP COLUMN'])
  expect(labels(migration)).toEqual(['DROP COLUMN', 'DROP INDEX'])
})

test('handles Windows line endings and keeps snippets clean', () => {
  const found = findDestructive('-- crlf file\r\nALTER TABLE t DROP COLUMN c;\r\n')
  expect(found.map((f) => f.label)).toEqual(['DROP COLUMN'])
  expect(found[0]?.snippet).toBe('ALTER TABLE t DROP COLUMN c;')
})

test('stays fast on a huge input', () => {
  const huge = `${'SELECT 1;\n'.repeat(200_000)}DROP TABLE late;`
  const started = Date.now()
  findDestructive(huge)
  classifyCommand(huge)
  expect(Date.now() - started).toBeLessThan(1_000)
})

// ------------------------------------------------------------- commands

test('catches migration runners', () => {
  for (const command of [
    'npm run migration:run',
    'pnpm db:migrate',
    'npx prisma migrate deploy',
    'npx typeorm migration:run -d ./data-source.ts',
    'node node_modules/typeorm/cli.js migration:run -d dist/data-source.js',
    'bin/rails db:migrate',
    'alembic -c alembic.ini upgrade head',
    'python manage.py migrate',
    'php artisan migrate:fresh --seed',
    'npx knex migrate:latest',
    'npx drizzle-kit push',
    'supabase db reset',
    'migrate -path db/migrations -database "$DATABASE_URL" up',
    'dotnet ef database update',
    'make migrate',
    'docker compose exec app npm run migration:run',
  ]) {
    expect(asks(command)).toBe(true)
  }
})

test('marks commands that undo or reset as risky', () => {
  expect(classifyCommand('npm run migration:run')?.risky).toBe(false)
  expect(classifyCommand('bin/rails db:rollback')?.risky).toBe(true)
  expect(classifyCommand('npx prisma migrate reset --force')?.risky).toBe(true)
  expect(classifyCommand('just db-reset')?.risky).toBe(true)
})

test('catches SQL run straight against a database', () => {
  expect(classifyCommand('psql "$DATABASE_URL" -c "DROP TABLE users"')?.risky).toBe(true)
  expect(classifyCommand('psql "$DATABASE_URL" -f migrations/001.sql')?.risky).toBe(true)
  expect(classifyCommand('mysql app < migrations/001.sql')?.risky).toBe(true)
  expect(classifyCommand('mongosh --eval "db.users.drop()"')?.risky).toBe(true)
  expect(asks('psql "$DATABASE_URL" -c "SELECT count(*) FROM users"')).toBe(false)
})

test('catches migration files changed from the shell', () => {
  expect(asks("cat > src/database/migrations/1890-x.ts <<'EOF'")).toBe(true)
  expect(asks('rm -rf src/database/migrations')).toBe(true)
  expect(asks('git mv migrations/001.sql migrations/002.sql')).toBe(true)
  expect(asks("find migrations -name '*.sql' -delete")).toBe(true)
  expect(asks('Remove-Item .\\migrations\\001.sql')).toBe(true)
  expect(asks('del migrations\\001.sql')).toBe(true)
  expect(asks('find migrations -name "*.sql" | xargs rm')).toBe(true)
  expect(asks('cd src/database/migrations && rm 001.sql')).toBe(true)
  expect(asks('rm -rf "$T/migrations"')).toBe(true)
})

test("doesn't blame an unrelated step for a migration path elsewhere", () => {
  expect(asks('rm -rf /tmp/scratch && echo "see migrations/001.sql"')).toBe(false)
  expect(asks('rm -rf /tmp/x && claude -p "write migrations/001.sql" | tail -5; ls migrations/ 2>&1')).toBe(false)
})

test('leaves reading, printing and searching alone', () => {
  expect(asks('cat migrations/001.sql')).toBe(false)
  expect(asks('cat migrations/001.sql > /tmp/copy.sql')).toBe(false)
  expect(asks('npm run migration:show')).toBe(false)
  expect(asks('npm run migration:generate -- src/database/migrations/AddX')).toBe(false)
  expect(asks('echo "would run npm run migration:run"')).toBe(false)
  expect(asks('git commit -m "add migration:run script"')).toBe(false)
  expect(asks('grep -r "migration:run" package.json')).toBe(false)
  expect(asks('Write-Output "npm run migration:run"')).toBe(false)
  expect(asks('git status')).toBe(false)
  expect(asks('npm run build')).toBe(false)
})

test("doesn't let a harmless first command hide a real one", () => {
  expect(asks('npm run migration:show && npm run migration:run')).toBe(true)
  expect(asks('echo done && npm run migration:run')).toBe(true)
  expect(asks('cd app & npm run migration:run')).toBe(true) // cmd.exe chaining
  expect(asks('npm.cmd run migration:run')).toBe(true) // Windows npm
})

test('takes an extra command pattern from settings', () => {
  expect(classifyCommand('make db-up', { extra: /make db-up/ })).toBeDefined()
})

// ------------------------------------------------------ the question

test('leads with the worst finding, its risk and what it does', () => {
  const findings = findDestructive('DROP INDEX idx;\nALTER TABLE users DROP COLUMN email;')
  const { header, question } = questionFor({ kind: 'file', key: 'k', what: 'write a migration file', target: '001.sql', findings })
  expect(header).toBe('High risk')
  expect(question).toBe(
    'Claude wants to write a migration file: 001.sql. DROP COLUMN: deletes the column and its data; DROP INDEX: can make queries slow. Found: ALTER TABLE users DROP COLUMN email. Allow it?',
  )
})

test('says so plainly when nothing destructive was found', () => {
  const { header, question } = questionFor({ kind: 'file', key: 'k', what: 'write a migration file', target: '001.sql', findings: [] })
  expect(header).toBe('Low risk')
  expect(question).toContain('Nothing destructive spotted.')
})

test('explains a migration command by its own risk', () => {
  const plain = classifyCommand('npm run migration:run')
  const undo = classifyCommand('npx prisma migrate reset --force')
  const ask = (hit: typeof plain) =>
    questionFor({ kind: 'command', key: 'k', what: hit?.reason ?? '', target: 'cmd', findings: hit?.findings ?? [], note: hit?.note, baseRisk: hit?.risky ? 'high' : 'medium' })
  expect(ask(plain).header).toBe('Medium risk')
  expect(ask(plain).question).toContain('It applies pending migrations to the database.')
  expect(ask(undo).header).toBe('High risk')
  expect(ask(undo).question).toContain('It can wipe the database or drop data.')
})

test('keeps long finding lists short, and every question is a question', () => {
  const findings = findDestructive('DROP TABLE a; DROP INDEX b; TRUNCATE c; ALTER TABLE d RENAME TO e;')
  const { header, question } = questionFor({ kind: 'file', key: 'k', what: 'write a migration file', target: 'x.sql', findings })
  expect(question).toContain('+2 more')
  expect(question.endsWith('?')).toBe(true)
  expect(header.length).toBeLessThanOrEqual(12) // the dialog's header chip limit
})

// ------------------------------------------- the guard, through the engine

const DROP = 'ALTER TABLE "users" DROP COLUMN "email";'

test('asks before a destructive migration write and blocks on no', async ($, on) => {
  const asked: string[] = []
  const headers: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked, headers)
  disk(on, wrote)

  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001_drop_email.sql', content: DROP })

  expect(asked.length).toBe(1)
  expect(headers).toEqual(['High risk'])
  expect(asked[0]).toContain('DROP COLUMN: deletes the column and its data')
  expect(wrote).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('did not allow')
})

test('lets the write through on yes', async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'Yes', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/001_drop_email.sql', content: DROP })

  expect(asked.length).toBe(1)
  expect(wrote).toEqual(['/repo/migrations/001_drop_email.sql'])
})

test("remembers don't ask again for the same file", async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'Yes for this file', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/002_x.sql', content: DROP })
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/002_x.sql', content: DROP })

  expect(asked.length).toBe(1)
  expect(wrote.length).toBe(2)
})

test('asks again when an approved file gains a new kind of destructive change', async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'Yes for this file', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/004_x.sql', content: 'DROP INDEX "idx";' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/004_x.sql', content: 'DROP INDEX "idx2";' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/004_x.sql', content: 'DROP TABLE "users";' })

  expect(asked.length).toBe(2)
  expect(asked[1]).toContain('DROP TABLE')
  expect(wrote.length).toBe(3)
})

test('treats Windows paths as the same file whatever the case', async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'Yes for this file', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: 'C:\\repo\\migrations\\005_x.sql', content: DROP })
  await $.tool.call({ tool: 'Write', file_path: 'c:\\Repo\\Migrations\\005_x.sql', content: DROP })

  expect(asked.length).toBe(1)
})

test('never asks about files outside migrations', async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/src/users.service.ts', content: DROP })

  expect(asked).toEqual([])
  expect(wrote).toEqual(['/repo/src/users.service.ts'])
})

test('destructive-only mode skips a safe migration', { options: { mode: 'destructive-only' } }, async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/003_add.sql', content: 'CREATE TABLE t (id int);' })

  expect(asked).toEqual([])
  expect(wrote.length).toBe(1)
})

test('destructive-only mode still asks before emptying a migration', { options: { mode: 'destructive-only' } }, async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/006_x.sql', content: '   \n' })

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Empties the file')
  expect(wrote).toEqual([])
})

test('asks before an edit deletes migration code', { options: { mode: 'destructive-only' } }, async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/migrations/007_x.sql',
    old_string: 'CREATE INDEX idx_users_email ON users (email);',
    new_string: '',
  })

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Removes code')
  expect(wrote).toEqual([])
})

test('blocks a migration command on no, and passes on what the person typed', async ($, on) => {
  const asked: string[] = []
  const ran: string[] = []
  person(on, 'use the staging database first', asked)
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  const r = await $.tool.call({ tool: 'Bash', command: 'npm run migration:run' })

  expect(asked.length).toBe(1)
  expect(ran).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('use the staging database first')
})

test('lets ordinary commands run without asking', async ($, on) => {
  const asked: string[] = []
  const ran: string[] = []
  person(on, 'No', asked)
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  expect(asked).toEqual([])
  expect(ran).toEqual(['npm test'])
})

test('fails closed when the guard itself breaks on a migration', async ($, on) => {
  // No clock is mocked here, so $.clock.now() throws inside the guard after the
  // "Yes for all" answer. Claude Code would normally run the tool anyway.
  const wrote: string[] = []
  person(on, 'Yes to all files, 15 min', [])
  disk(on, wrote)

  const r = await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/050_x.sql', content: 'CREATE TABLE x (id int);' })

  expect(wrote).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('internal error')
})

// ------------------------------------------------ many files at once

test('"Yes for all" covers a batch of migration files for 15 minutes, but never high-risk ones', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  const wrote: string[] = []
  person(on, ['Yes to all files, 15 min', 'Yes', 'Yes'], asked)
  disk(on, wrote)

  // The first file asks, and the answer opens the window.
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/010_a.sql', content: 'CREATE TABLE a (id int);' })
  // Ten more ordinary files go through without a question.
  for (let i = 11; i <= 20; i++) {
    await $.tool.call({ tool: 'Write', file_path: `/repo/migrations/0${i}_x.sql`, content: 'CREATE INDEX i ON a (id);' })
  }
  expect(asked.length).toBe(1)

  // A high-risk one still asks inside the window.
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/021_drop.sql', content: 'DROP TABLE a;' })
  expect(asked.length).toBe(2)

  // After 15 minutes the window is closed again.
  await clock.advance(15 * 60_000 + 1)
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/022_b.sql', content: 'CREATE TABLE b (id int);' })
  expect(asked.length).toBe(3)
  expect(wrote.length).toBe(13)
})

test('"Yes for all" never covers running migrations', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  const ran: string[] = []
  person(on, ['Yes to all files, 15 min', 'No'], asked)
  disk(on, [])
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/030_a.sql', content: 'CREATE TABLE a (id int);' })
  await $.tool.call({ tool: 'Bash', command: 'npm run migration:run' })

  expect(asked.length).toBe(2)
  expect(ran).toEqual([])
})

test('offers No first, and "Yes to all files" only where it would apply', async ($, on) => {
  const offered: string[][] = []
  person(on, 'No', [], [], offered)
  disk(on, [])
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/040_a.sql', content: 'CREATE TABLE a (id int);' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/041_b.sql', content: 'DROP TABLE a;' })
  await $.tool.call({ tool: 'Bash', command: 'npm run migration:run' })

  expect(offered).toEqual([
    ['No', 'Yes', 'Yes for this file', 'Yes to all files, 15 min'],
    ['No', 'Yes', 'Yes for this file'],
    ['No', 'Yes', 'Yes for this command'],
  ])
})
