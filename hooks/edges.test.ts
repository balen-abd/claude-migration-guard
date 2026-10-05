// The tricky cases: ways around the guard, and ways it could cry wolf.

import { expect, mock, test } from 'claude-code/testing'
import { classifyCommand, classifyMcpCall, findDestructive, isMigrationPath, isUndoFile } from './detect'
import { questionFor } from './question'
import { disk, mcp, person, shell } from './stand-ins'

const labels = (text: string, skipDown = false) => findDestructive(text, { skipDown }).map((f) => f.label)
const asks = (command: string) => classifyCommand(command) !== undefined
const ps = (command: string) => classifyCommand(command, { powershell: true }) !== undefined

// ------------------------------------------------------------- commands

test('sees through monorepo flags and wrappers', () => {
  for (const command of [
    'pnpm --filter api db:migrate',
    'pnpm -C apps/api migrate',
    'npm --prefix api run migrate',
    'npm run -w api migration:run',
    'yarn workspace @acme/api migrate',
    'turbo run db:migrate --filter=api',
    'nx run api:migrate',
    'npm run db:push',
    'pnpm db:reset',
    'NODE_ENV=production npm run migration:run',
    'ssh prod "cd /app && npm run migration:run"',
    'bash -c "npx prisma migrate deploy"',
    'kubectl exec deploy/api -- npm run migration:run',
    'echo "$(npm run migration:run)"', // command substitution runs, even inside echo
  ]) {
    expect(asks(command)).toBe(true)
  }
})

test('covers more migration tools', () => {
  for (const command of [
    'flask db upgrade',
    'bin/console doctrine:migrations:migrate --no-interaction',
    'vendor/bin/phinx migrate',
    'php artisan db:wipe',
    'npx sequelize-cli db:migrate:undo:all',
    'npx node-pg-migrate up',
    'sqitch deploy',
    'hasura migrate apply',
    'wrangler d1 migrations apply prod-db',
    'npx typeorm schema:drop -d dist/data-source.js',
    'node scripts/migrate.ts',
    'python migrate.py',
    'go run ./cmd/migrate up',
    'dotnet ef migrations remove',
  ]) {
    expect(asks(command)).toBe(true)
  }
})

test('joins line continuations before reading', () => {
  expect(asks('rm \\\n  src/database/migrations/001.sql')).toBe(true)
  expect(ps('Remove-Item `\n  .\\migrations\\001.sql')).toBe(true)
})

test('names what a risky command does', () => {
  expect(classifyCommand('alembic downgrade -1')?.note).toContain('undoes applied migrations')
  expect(classifyCommand('python manage.py migrate shop zero')?.risky).toBe(true)
  expect(classifyCommand('npx prisma db push')?.note).toContain('can drop data')
  expect(classifyCommand('npx prisma migrate resolve --applied 2026_init')?.note).toContain('count as applied')
  expect(classifyCommand('php artisan migrate --force')?.note).toContain('forced')
  expect(classifyCommand('npm run migration:run')?.note).toBe('it applies pending migrations to the database')
})

test('catches commands that wipe a database outright', () => {
  expect(classifyCommand('docker compose down -v')?.reason).toBe('delete Docker volumes')
  expect(classifyCommand('docker-compose -f dev.yml down --volumes')?.risky).toBe(true)
  expect(classifyCommand('docker volume rm app_pgdata')?.risky).toBe(true)
  expect(classifyCommand('dropdb app_dev')?.reason).toBe('drop a database')
  expect(classifyCommand('pg_restore --clean -d app dump.pgc')?.risky).toBe(true)
  expect(classifyCommand('pg_restore -d app dump.pgc')?.risky).toBe(false)
  expect(asks('docker compose down')).toBe(false)
  expect(asks('pg_restore -l dump.pgc')).toBe(false) // only lists the dump
})

test('catches SQL fed to a client in every common way', () => {
  expect(asks('cat migrations/001.sql | psql "$DATABASE_URL"')).toBe(true)
  expect(asks('gunzip -c dump.sql.gz | psql app')).toBe(true)
  expect(asks('psql app -c "$(cat schema/001.sql)"')).toBe(true)
  expect(asks('psql app <<EOF\nDROP TABLE users;\nEOF')).toBe(true)
  expect(asks('cat <<EOF | psql app\nTRUNCATE sessions;\nEOF')).toBe(true)
  expect(asks('docker exec -i db psql -U postgres < seed.sql')).toBe(true)
  expect(asks('python manage.py dbshell < fix.sql')).toBe(true)
  expect(asks('wrangler d1 execute prod --command "DROP TABLE users"')).toBe(true)
  expect(asks('npx prisma db execute --file ./fix.sql')).toBe(true)
  expect(asks('psql app -c "UPDATE users u SET active = false"')).toBe(true)
})

test('catches migration files changed by one-liners and other shells', () => {
  expect(asks(`node -e "require('fs').writeFileSync('migrations/001.sql', '')"`)).toBe(true)
  expect(asks(`python3 -c "import os; os.remove('db/migrate/20260101_x.rb')"`)).toBe(true)
  expect(asks("python3 - <<'EOF'\nimport shutil\nshutil.rmtree('migrations')\nEOF")).toBe(true)
  expect(asks("sed -e 's/a/b/' -i migrations/001.sql")).toBe(true)
  expect(asks("find . -path '*migrations*' -delete")).toBe(true)
  expect(asks('git checkout main -- src/database/migrations/')).toBe(true)
  expect(ps('ri .\\migrations\\001.sql')).toBe(true)
  expect(ps('Set-Content -Path migrations\\001.sql -Value ""')).toBe(true)
  expect(asks("git apply <<'EOF'\n--- a/migrations/001.sql\n+++ b/migrations/001.sql\n@@ -1 +1 @@\n-int\n+bigint\nEOF")).toBe(true)
  expect(asks("git apply <<'EOF'\n--- a/src/app.ts\n+++ b/src/app.ts\nEOF")).toBe(false)
})

test('stays quiet on commit messages, PR bodies and docs that mention migrations', () => {
  expect(asks('git commit -m "Move old migrations/ into archive"')).toBe(false)
  expect(asks('git commit -m "fix psql DROP TABLE typo in docs"')).toBe(false)
  expect(asks("git commit -m \"$(cat <<'EOF'\nMove applied migrations/index to done\n\nRun npm run migration:run after pulling.\nEOF\n)\"")).toBe(false)
  expect(asks("gh pr create --title x --body \"$(cat <<'EOF'\nrm migrations/old.sql, then psql -f migrations/new.sql\nEOF\n)\"")).toBe(false)
  expect(asks('echo "remember: npm run migration:run" && npm test')).toBe(false)
})

test("doesn't mistake ordinary work for a migration", () => {
  for (const command of [
    'npm run test:migrations',
    'npx jest src/database/migration-release-policy.spec.ts',
    'node --test scripts/active-migration-release-policy.test.mjs',
    'npm install migrate-mongo',
    'nx migrate latest', // Nx upgrades the workspace, not a database
    'npx knex migrate:make add_users',
    'flask db migrate -m "add users"', // only writes a new migration file
    'alembic revision --autogenerate -m "add users"',
    'docker compose -f compose.dev.yml exec db psql -U postgres -c "select count(*) from users"',
    'ls migrations/ && cat migrations/001.sql',
    'git add src/database/migrations/',
    'git diff -- migrations/',
    'python -m pytest tests/migrations',
  ]) {
    expect(asks(command)).toBe(false)
  }
})

test('reads PowerShell quoting, where the backtick escapes', () => {
  expect(ps('Write-Output "C:\\repo\\" ; npm run migration:run')).toBe(true)
  expect(ps('Write-Output "see npm run migration:run"')).toBe(false)
})

test('stays fast on long, hostile commands', () => {
  const started = Date.now()
  classifyCommand(`knex ${'knex '.repeat(50_000)}`)
  classifyCommand(`npm ${'--flag value '.repeat(20_000)}`)
  classifyCommand(`echo "${'a && b; '.repeat(20_000)}"`)
  classifyCommand(`cat <<EOF\n${'line\n'.repeat(50_000)}EOF`)
  expect(Date.now() - started).toBeLessThan(2_000)
})

// ------------------------------------------------------------- files

test('knows Liquibase changelogs', () => {
  expect(isMigrationPath('/app/src/main/resources/db/changelog/changes/001-users.xml')).toBe(true)
  expect(isMigrationPath('/app/src/main/resources/db/changelog/db.changelog-master.yaml')).toBe(true)
  expect(isMigrationPath('/app/.github/release-drafter.yml')).toBe(false)
  expect(isMigrationPath('/app/package.json')).toBe(false)
  expect(labels('<dropColumn tableName="users" columnName="email"/>')).toEqual(['DROP COLUMN'])
  expect(labels('- dropTable:\n    tableName: users')).toEqual(['DROP TABLE'])
  expect(labels('<modifyDataType tableName="t" columnName="c" newDataType="int"/>')).toEqual(['ALTER COLUMN TYPE'])
})

test('reads more ORMs', () => {
  expect(labels("Schema::drop('users');")).toEqual(['DROP TABLE'])
  expect(labels("$table->string('name', 50)->change();")).toEqual(['ALTER COLUMN'])
  expect(labels("await queryInterface.removeColumn('users', 'email')")).toEqual(['DROP COLUMN'])
  expect(labels("await queryInterface.changeColumn('users', 'age', { type: 'TEXT' })")).toEqual(['ALTER COLUMN'])
  expect(labels('drop_join_table :users, :roles')).toEqual(['DROP TABLE'])
  expect(labels('UPDATE ONLY users SET active = false;')).toEqual(['UPDATE without WHERE'])
})

test('skips the down half of goose, dbmate and sql-migrate files', () => {
  const goose = '-- +goose Up\nCREATE TABLE users (id int);\n\n-- +goose Down\nDROP TABLE users;\n'
  const dbmate = '-- migrate:up\nCREATE TABLE users (id int);\n-- migrate:down\nDROP TABLE users;\n'
  expect(labels(goose, true)).toEqual([])
  expect(labels(dbmate, true)).toEqual([])
  expect(labels('-- +goose Up\nALTER TABLE users DROP COLUMN email;\n-- +goose Down\n', true)).toEqual(['DROP COLUMN'])
})

test('knows undo files by name', () => {
  expect(isUndoFile('/app/migrations/000001_create_users.down.sql')).toBe(true)
  expect(isUndoFile('/app/migrations/2026-01-01-000000_users/down.sql')).toBe(true)
  expect(isUndoFile('/app/db/migration/U2__drop_users.sql')).toBe(true)
  expect(isUndoFile('/app/migrations/000001_create_users.up.sql')).toBe(false)
  expect(isUndoFile('/app/migrations/002_slowdown.sql')).toBe(false)
})

// ------------------------------------------------------------- MCP tools

test('catches database MCP tools', () => {
  expect(classifyMcpCall('mcp__supabase__apply_migration', { name: 'add_users', query: 'CREATE TABLE users (id int);' })?.kind).toBe('command')
  expect(classifyMcpCall('mcp__supabase__execute_sql', { query: 'DROP TABLE users;' })?.risky).toBe(true)
  expect(classifyMcpCall('mcp__neon__run_sql', { sql: 'TRUNCATE sessions;' })?.risky).toBe(true)
  expect(classifyMcpCall('mcp__prisma__migrate-reset', { projectCWD: '/app' })?.risky).toBe(true)
  expect(classifyMcpCall('mcp__supabase__execute_sql', { query: 'SELECT * FROM users LIMIT 5;' })).toBeUndefined()
  expect(classifyMcpCall('mcp__supabase__list_migrations', {})).toBeUndefined()
  expect(classifyMcpCall('mcp__prisma__migrate-status', {})).toBeUndefined()
})

test('catches MCP tools that write migration files, and nothing that only mentions one', () => {
  const hit = classifyMcpCall('mcp__filesystem__write_file', { path: '/app/migrations/001.sql', content: 'DROP TABLE users;' })
  expect(hit?.kind).toBe('file')
  expect(hit?.findings.map((f) => f.label)).toEqual(['DROP TABLE'])
  expect(classifyMcpCall('mcp__github__create_or_update_file', { path: 'db/migrate/20260101_x.rb', content: 'x' })?.kind).toBe('file')
  expect(classifyMcpCall('mcp__filesystem__move_file', { source: '/app/migrations/1.sql', destination: '/tmp/1.sql' })?.kind).toBe('file')
  expect(classifyMcpCall('mcp__github__create_issue', { title: 'migrations/001.sql is broken', body: 'DROP TABLE users fails' })).toBeUndefined()
  expect(classifyMcpCall('mcp__filesystem__read_file', { path: '/app/migrations/001.sql' })).toBeUndefined()
  expect(classifyMcpCall('mcp__slack__send_message', { text: 'ran DROP TABLE users on staging' })).toBeUndefined()
})

// ------------------------------------------------------------- the question

test('shows the line it found, unless the command already shows it', () => {
  const file = questionFor({ kind: 'file', key: 'k', what: 'write a migration file', target: 'x.sql', findings: findDestructive('DROP TABLE users;') })
  expect(file.question).toContain('Found: DROP TABLE users. Allow it?')
  const hit = classifyCommand('psql app -c "DROP TABLE users"')
  const cmd = questionFor({ kind: 'command', key: 'k', what: hit?.reason ?? '', target: 'psql app -c "DROP TABLE users"', findings: hit?.findings ?? [] })
  expect(cmd.question).not.toContain('Found:')
})

// ------------------------------------------------------------- through the engine

test('guards Monitor, which also runs shell commands', async ($, on) => {
  const asked: string[] = []
  const ran: string[] = []
  person(on, 'No', asked)
  shell(on, ran)

  await $.tool.call({ tool: 'Monitor', description: 'watch', timeout_ms: 60_000, command: 'npm run migration:run' })

  expect(asked.length).toBe(1)
  expect(ran).toEqual([])
})

test('asks before destructive SQL through an MCP server, with the line it found', async ($, on) => {
  const asked: string[] = []
  const headers: string[] = []
  const called: string[] = []
  person(on, 'No', asked, headers)
  mcp(on, called)

  await $.tool.call({ tool: 'mcp__supabase__execute_sql', project_id: 'p1', query: 'DROP TABLE users;' })
  await $.tool.call({ tool: 'mcp__supabase__execute_sql', project_id: 'p1', query: 'SELECT 1;' })

  expect(asked.length).toBe(1)
  expect(headers).toEqual(['High risk'])
  expect(asked[0]).toContain('execute_sql (supabase)')
  expect(asked[0]).toContain('Found: DROP TABLE users.')
  expect(called).toEqual(['mcp__supabase__execute_sql'])
})

test('reminds that editing a migration that already ran changes nothing', async ($, on) => {
  const asked: string[] = []
  person(on, 'Yes', asked)
  disk(on, [])

  await $.tool.call({ tool: 'Edit', file_path: '/repo/migrations/001.sql', old_string: 'int', new_string: 'bigint' })

  expect(asked[0]).toContain("If it already ran, editing it won't change the database.")
})

test("doesn't call an undo file high risk", async ($, on) => {
  const headers: string[] = []
  const asked: string[] = []
  person(on, 'Yes', asked, headers)
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/000001_users.down.sql', content: 'DROP TABLE users;' })

  expect(headers).toEqual(['Low risk'])
  expect(asked[0]).toContain('only runs on rollback')
})

test('fails closed on any migration path, even one with nothing alarming in it', async ($, on) => {
  const wrote: string[] = []
  person(on, 'Yes to all files, 15 min', [])
  disk(on, wrote)

  // No clock is mocked, so the guard throws after the answer; drizzle/ paths
  // don't say "migration", which the old check relied on.
  const r = await $.tool.call({ tool: 'Write', file_path: '/app/drizzle/0001_init.sql', content: 'CREATE TABLE x (id int);' })

  expect(wrote).toEqual([])
  expect(r.deny ?? r.text ?? '').toContain('internal error')
})

test('"Yes to all files" also covers migration files written through MCP', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const asked: string[] = []
  const called: string[] = []
  person(on, ['Yes to all files, 15 min'], asked)
  disk(on, [])
  mcp(on, called)

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/060_a.sql', content: 'CREATE TABLE a (id int);' })
  await $.tool.call({ tool: 'mcp__filesystem__write_file', path: '/repo/migrations/061_b.sql', content: 'CREATE TABLE b (id int);' })

  expect(asked.length).toBe(1)
  expect(called.length).toBe(1)
})

// ------------------------------------------------- found in the second audit

test('reads still more ORM and SQL forms', () => {
  expect(labels("with op.batch_alter_table('users') as batch_op:\n    batch_op.drop_column('email')")).toEqual(['DROP COLUMN'])
  expect(labels('alter table(:users) do\n  remove :email\nend')).toEqual(['DROP COLUMN']) // Ecto
  expect(labels('drop_if_exists table(:users)')).toEqual(['DROP TABLE'])
  expect(labels("pgm.dropConstraint('users', 'fk_org')")).toEqual(['DROP CONSTRAINT']) // node-pg-migrate
  expect(labels("$this->table('users')->removeColumn('email')->save();")).toEqual(['DROP COLUMN']) // Phinx
  expect(labels("$table->dropConstrainedForeignId('user_id');")).toEqual(['DROP COLUMN'])
  expect(labels("await knex('sessions').del()")).toEqual(['DELETE without WHERE'])
  expect(labels('await prisma.session.deleteMany()')).toEqual(['DELETE without WHERE'])
  expect(labels('ALTER TABLE users ADD COLUMN a int, DROP b;')).toEqual(['DROP COLUMN'])
  expect(labels('ALTER TABLE users RENAME email TO mail;')).toEqual(['RENAME'])
  expect(labels('ALTER TABLE t ALTER c TYPE bigint;')).toEqual(['ALTER COLUMN TYPE'])
  expect(labels('ALTER TABLE t MODIFY c varchar(10);')).toEqual(['MODIFY COLUMN'])
  expect(labels('DELETE FROM users WHERE 1;')).toEqual(['DELETE without WHERE'])
  expect(labels('ALTER TABLE logs DROP PARTITION p2023;')).toEqual(['DROP PARTITION'])
  expect(labels('DROP EXTENSION postgis CASCADE;')).toEqual(['DROP EXTENSION', 'CASCADE'])
  expect(labels("$table->dropRememberToken();")).toEqual(['DROP COLUMN'])
  expect(labels("$table->dropSomethingNew();")).toEqual(['dropSomethingNew()'])
})

test('stays quiet on look-alikes', () => {
  expect(labels('GRANT SELECT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO app;')).toEqual([])
  expect(labels('CREATE TRIGGER t AFTER TRUNCATE ON users FOR EACH STATEMENT EXECUTE FUNCTION f();')).toEqual([])
  expect(labels('ALTER TABLE a DROP CONSTRAINT fk, ADD CONSTRAINT fk FOREIGN KEY (b) REFERENCES c ON DELETE CASCADE;')).toEqual(['DROP CONSTRAINT'])
  expect(labels('DELETE FROM jobs WHERE 1=1 AND id = 5;')).toEqual([]) // a query builder's WHERE 1=1 with real conditions
  expect(findDestructive('op.execute("SELECT 1")  # TODO: DROP TABLE legacy later', { hashComments: true })).toEqual([])
})

test('a /* inside a string cannot hide what follows', () => {
  expect(labels("COMMENT ON TABLE x IS 'files in uploads/*';\nDROP TABLE y;\n/* end */")).toEqual(['DROP TABLE'])
  expect(labels('DROP/**/TABLE users;')).toEqual(['DROP TABLE'])
})

test('knows where more formats keep their undo half', () => {
  const sequelize = "module.exports = {\n  up: async (qi) => { await qi.createTable('users', {}) },\n  down: async (qi) => { await qi.dropTable('users') },\n}"
  const umzug = "export const up: MigrationFn = async ({ context }) => {}\nexport const down: MigrationFn = async ({ context }) => { await context.dropTable('users') }"
  const goGoose = 'func upAddUsers(ctx context.Context, tx *sql.Tx) error { return nil }\nfunc downAddUsers(ctx context.Context, tx *sql.Tx) error {\n  _, err := tx.Exec("DROP TABLE users")\n  return err\n}'
  const play = '# --- !Ups\nCREATE TABLE users (id int);\n# --- !Downs\nDROP TABLE users;'
  const django = 'migrations.RunSQL("CREATE TABLE t (id int)", reverse_sql="DROP TABLE t"),\nmigrations.RemoveField(model_name="user", name="email"),'
  for (const text of [sequelize, umzug, goGoose, play]) expect(labels(text, true)).toEqual([])
  expect(labels(django, true)).toEqual(['DROP COLUMN']) // the reverse is skipped, what comes after is not
  // A "down(" that's only mentioned inside up() doesn't end the forward half.
  expect(labels("async up(q) { await q.query('DROP TABLE legacy') /* see down() */ }\nasync down(q) {}", true)).toEqual(['DROP TABLE'])
})

test('takes more tools and flags into account', () => {
  for (const command of [
    'npx typeorm query "DROP TABLE users"',
    'bin/rails db:truncate_all',
    'python manage.py reset_db --noinput',
    'atlas schema clean -u "$DATABASE_URL"',
    'docker compose run --rm migrate',
    'make -C api migrate',
    "npm run 'db:migrate'",
    'npm run mig""ration:run',
    'heroku pg:reset DATABASE_URL --confirm my-app',
    'Invoke-Sqlcmd -Query "DROP TABLE users" -ServerInstance .',
    'tar xzf backup.tgz -C src/database/migrations',
    'unzip -o m.zip -d migrations/',
    'dd if=/dev/null of=migrations/001.sql',
    'curl -o migrations/003.sql https://example.com/x.sql',
    'git stash push -- src/database/migrations',
    'rm drizzle/0003_add_users.sql',
    'perl -0pi -e "s/a/b/" migrations/001.sql',
  ]) {
    expect(asks(command)).toBe(true)
  }
  expect(classifyCommand('./gradlew flywayClean')?.risky).toBe(true)
  expect(classifyCommand('liquibase dropAll')?.risky).toBe(true)
  expect(classifyCommand('dotnet ef database update 0')?.risky).toBe(true)
  expect(classifyCommand('bin/rails db:migrate VERSION=0')?.risky).toBe(true)
})

test('leaves reads, plans and other tools alone', () => {
  for (const command of [
    'cp migrations/001.sql /tmp/backup.sql',
    'cp -r src/database/migrations /tmp/migrations-backup',
    'git restore --staged src/database/migrations/001.ts',
    'git checkout -b fix/migration',
    'cd src/database/migrations && ls && cd /tmp && rm -rf scratch',
    'tar czf backup.tgz migrations/',
    'psql -A -F "," -c "SELECT id, email FROM users"',
    'helm install mysql bitnami/mysql -f values.yaml',
    'kubectl apply -f k8s/mysql.yaml',
    'tail -f /var/log/mysql/error.log',
    'npx prisma migrate dev --create-only --name add_users',
    'npm run migrate create add-users',
    'python manage.py migrate --plan',
    'liquibase update-sql',
  ]) {
    expect(asks(command)).toBe(false)
  }
})

test('a direct DROP INDEX is medium risk, not high', () => {
  const hit = classifyCommand('psql app -c "DROP INDEX CONCURRENTLY idx_a"')
  expect(hit?.risky).toBe(false)
  expect(hit?.findings.map((f) => f.label)).toEqual(['DROP INDEX'])
})

test('a migration written with cat and a heredoc is judged by what is in it', () => {
  const safe = classifyCommand("cat > migrations/002.sql <<'EOF'\nCREATE TABLE b (id int);\nEOF")
  const drop = classifyCommand("cat > migrations/003.sql <<'EOF'\nDROP TABLE b;\nEOF")
  expect(safe?.risky).toBe(false)
  expect(drop?.risky).toBe(true)
  expect(drop?.findings.map((f) => f.label)).toEqual(['DROP TABLE'])
  expect(classifyCommand('rm migrations/003.sql')?.risky).toBe(true)
})

test('knows more migration folders, and not tests or vendored code', () => {
  for (const path of ['/app/sqitch/deploy/add_users.sql', '/app/conf/evolutions/default/1.sql', '/app/drizzle/meta/_journal.json', '/app/db/migrations/001_init.pgsql', '/app/Sources/App/Migrations/CreateTodo.swift']) {
    expect(isMigrationPath(path)).toBe(true)
  }
  for (const path of ['/repo/tests/migrations/test_0002_backfill.py', '/repo/spec/db/migrate/add_users_spec.rb', '/repo/internal/migrations/migrate_test.go', '/repo/src/database/migrations/__tests__/helpers.ts', '/repo/node_modules/typeorm/migration/MigrationExecutor.js']) {
    expect(isMigrationPath(path)).toBe(false)
  }
})

test('shows the part of a long command that matters', async ($, on) => {
  const asked: string[] = []
  person(on, 'No', asked)
  shell(on, [])

  await $.tool.call({ tool: 'Bash', command: 'cd /home/me/projects/acme/services/billing-api && npm ci && npm run lint && npm run build && npm test && npx prisma migrate reset --force' })

  expect(asked[0]).toContain('... npx prisma migrate reset --force')
})

test("doesn't take findings from a commit message in the same command", async ($, on) => {
  const asked: string[] = []
  person(on, 'No', asked)
  shell(on, [])

  await $.tool.call({ tool: 'Bash', command: 'npm run migration:run && git commit -m "drop column email from the form"' })

  expect(asked[0]).not.toContain('DROP COLUMN')
})

test('destructive-only mode still asks when an edit drops a CREATE INDEX', { options: { mode: 'destructive-only' } }, async ($, on) => {
  const asked: string[] = []
  const wrote: string[] = []
  person(on, 'No', asked)
  disk(on, wrote)

  await $.tool.call({
    tool: 'Edit',
    file_path: '/repo/migrations/007_x.sql',
    old_string: 'CREATE TABLE t (id int);\nCREATE INDEX idx_t ON t (id);',
    new_string: 'CREATE TABLE t (id int);',
  })

  expect(asked.length).toBe(1)
  expect(asked[0]).toContain('Found: CREATE INDEX idx_t ON t (id).')
  expect(wrote).toEqual([])
})

test('destructive-only mode still asks when a write leaves only a comment', { options: { mode: 'destructive-only' } }, async ($, on) => {
  const asked: string[] = []
  person(on, 'No', asked)
  disk(on, [])

  await $.tool.call({ tool: 'Write', file_path: '/repo/migrations/008_x.sql', content: '-- intentionally left blank\n' })

  expect(asked[0]).toContain('Empties the file')
})

// Found live: the guard asked about its own author's commands, run from a folder named migration-guard.
test('a folder whose name only starts with "migration" is not a migrations folder', () => {
  expect(asks('cd /home/me/.claude/mods/migration-guard/hooks && rm -rf /tmp/scratch')).toBe(false)
  expect(asks("cd /home/me/.claude/mods/migration-guard/hooks && sed -i 's/a/b/' register.ts")).toBe(false)
  expect(asks('cd src/modules/data-migration && rm old.service.ts')).toBe(false)
  expect(asks('echo x > src/data-migrations/a.ts')).toBe(false)
  expect(asks('cd src/database/migrations && rm 001.sql')).toBe(true)
  expect(asks('cd "$ROOT"/migrations && rm 001.sql')).toBe(true)
  expect(asks('echo x > "$ROOT"/migrations/001.sql')).toBe(true)
})

// Found live while posting the demo: a sed script that mentions "migration" asked about notes.
test('the script sed or perl runs is not where the edit lands', () => {
  expect(asks('sed -i "s/before it touches a migration/before a migration/" mg-post.txt')).toBe(false)
  expect(asks("sed -i 's/a migration/the migration/' notes.txt")).toBe(false)
  expect(asks("sed -i -e 's|old|migrations/|' -e 's/x/y/' README.md")).toBe(false)
  expect(asks("sed -i '' 's/migrations\\//db\\//' docs/setup.md")).toBe(false)
  expect(asks("sed -i.bak --expression='s/migration/m/' a.txt")).toBe(false)
  expect(asks("perl -pi -e 's/migrations\\//db\\//' notes.txt")).toBe(false)
  expect(asks("perl -pi -e 's/a/b/' -- notes.txt")).toBe(false)
  // The files it edits still count, quoted or not, and so does a list piped in.
  expect(asks("sed -i 's/old/new/' db/migrations/0042_x.sql")).toBe(true)
  expect(asks('sed -i "s/old/new/" "db/migrations/0042 x.sql"')).toBe(true)
  expect(asks("sed -i -e 's/a/b/' migrations/0042_x.sql")).toBe(true)
  expect(asks("sed -i '' 's/a/b/' migrations/0042_x.sql")).toBe(true)
  expect(asks("perl -pi -e 's/a/b/' migrations/0042_x.sql")).toBe(true)
  expect(asks("find migrations -name '*.sql' | xargs sed -i 's/a/b/'")).toBe(true)
  expect(asks("cd db/migrations && sed -i 's/a/b/' 0042_x.sql")).toBe(true)
  // Another verb in the same step is judged on the whole step, as before.
  expect(asks("sed -i 's/a/b/' x.txt | rm migrations/0042_x.sql")).toBe(true)
})

// From a replay of 26,000 real commands: these asked before and shouldn't.
test('stays quiet on the read-only work a real session is full of', () => {
  for (const command of [
    'grep -rni "selling_prices" src/database/ --include=*.ts -l | grep -v "/migrations/index/" | head -40', // -rni is not Rename-Item
    'cd src/database/migrations && grep -rn "sales_invoices" --include=*.ts -l . | xargs grep -ln "CREATE TRIGGER\\|TRUNCATE"',
    "grep -nI -iE 'INDEX|change_logs' src/database/migrations/index/1990000003500-x.ts | cut -c1-220 | head -60",
    "cat > src/database/migrations/index/1890000015560-x.spec.ts <<'TS'\nimport { QueryRunner } from 'typeorm'\nTS", // a test next to migrations
    // python editing a doc that talks about migrations
    "python3 - <<'EOF'\np='docs/plan.md'\ns=open(p).read()\ns=s.replace('old', 'Run `npm run migration:run`, then check src/database/migrations/index/1990.ts')\nopen(p,'w').write(s)\nEOF",
    // python editing a test whose new text contains SQL and a .query( call
    "python3 - <<'EOF'\np='scripts/policy.test.mjs'\ns=open(p).read()\ns=s.replace('// end', '''await client.query(\"DROP TABLE x\")''')\nopen(p,'w').write(s)\nEOF",
    // python reading a migration and writing its findings somewhere else
    "python3 - <<'EOF'\nimport json\nsrc=open('src/database/migrations/index/001.ts').read()\njson.dump({'n': len(src)}, open('/tmp/out.json','w'))\nEOF",
    // an edit() helper used on ordinary files, one of which mentions a migration in its new text
    "python3 - <<'EOF'\ndef edit(path, old, new):\n    s=open(path).read()\n    open(path,'w').write(s.replace(old,new))\nedit('src/app.module.ts','a','b')\nedit('docs/plan.md','x','see src/database/migrations/index/1990.ts')\nEOF",
  ]) {
    expect(asks(command)).toBe(false)
  }
})

test('catches scripts that really change migrations, run them, or run SQL', () => {
  const edit = classifyCommand("python3 - <<'EOF'\np='src/database/migrations/index/1990.ts'\ns=open(p).read().replace('a','b')\nopen(p,'w').write(s)\nEOF")
  expect(edit?.reason).toBe('change a migration file from a script')
  expect(edit?.part).toBe('.../migrations/index/1990.ts') // the question names the file, not the script
  expect(asks("python3 - <<'EOF'\ndef edit(path, old, new):\n    s=open(path).read()\n    open(path,'w').write(s.replace(old,new))\nedit('src/database/migrations/index/1990.ts','a','b')\nEOF")).toBe(true)
  expect(asks("python3 - <<'EOF'\nts='1990'\nopen(f'src/database/migrations/index/{ts}-repair.ts','w').write(src)\nEOF")).toBe(true)
  expect(classifyCommand(`python3 -c "import subprocess; subprocess.run(['npx','prisma','migrate','reset','--force'])"`)?.risky).toBe(true)
  expect(classifyCommand("python3 - <<'EOF'\nimport psycopg\ncur = psycopg.connect().cursor()\ncur.execute(\"TRUNCATE sessions\")\nEOF")?.reason).toBe('run destructive SQL from a script')
  expect(asks(`cd db/migrate && python3 -c "import os; os.remove('20260101_add_users.rb')"`)).toBe(true)
})

test('stays fast when a script is nothing but writes', () => {
  const started = Date.now()
  classifyCommand(`python3 - <<'EOF'\n${"open(p, 'w') ".repeat(20_000)}\nEOF`)
  expect(Date.now() - started).toBeLessThan(2_000)
})
