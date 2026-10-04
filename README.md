# migration-guard

A Claude Code mod that makes Claude ask before it touches your database migrations.

I let Claude Code work on a large Postgres codebase every day, and it's good at it. But migrations are the one place where "looks fine" isn't enough. A single generated file can drop a column or quietly lose a pile of indexes, and you find out in production. So this makes Claude ask me first, and only for migrations and the database.

## What you see

```
 High risk
 Claude wants to write a migration file: .../db/migrations/0042_cleanup.sql.
 DROP COLUMN: deletes the column and its data; DROP INDEX: can make queries
 slow. Found: ALTER TABLE "users" DROP COLUMN "email". Allow it?

 1. No                 Block it. Claude is told to stop and not work around it.
 2. Yes                Allow this once.
 3. Yes for this file  Don't ask again for this file, unless something more
                       destructive shows up.
```

No comes first, so an accidental Enter (or anything that picks the first option for you) blocks.

Commands get the same treatment:

```
 High risk
 Claude wants to run prisma: npx prisma migrate reset --force.
 It can wipe the database or drop data. Allow it?
```

Say no, or type what you want instead ("make a new migration, don't edit this one"), and Claude is told to stop and not work around it.

## When it asks

- Claude writes or edits a migration file: TypeORM, Prisma, Rails, Django, Alembic, Knex, Sequelize, Laravel, Doctrine, EF Core, Flyway, Liquibase, goose, Supabase, Drizzle and more.
- Claude runs migrations: `npm run migration:run`, `pnpm --filter api db:migrate`, `prisma migrate deploy`, `rails db:rollback`, `alembic downgrade`, `php artisan migrate`, `dotnet ef database update`, `make migrate`, and about 30 other tools.
- Claude changes migration files from the shell or a script: `cat >`, `sed -i`, `rm`, `git checkout --`, `find ... -delete`, `Remove-Item`, a `node -e`/`python -c` one-liner, or a Python heredoc that rewrites one.
- Claude runs SQL straight against a database: `psql -c "DROP TABLE ..."`, `psql -f file.sql`, `cat x.sql | psql`, `mongosh --eval "db.users.drop()"`, `dropdb`, `docker compose down -v`.
- Claude uses an MCP server that migrates or runs SQL: Supabase's `apply_migration`, `execute_sql` with a `DROP` in it, Prisma's `migrate-reset`, or a filesystem server writing into `migrations/`.

It watches Claude Code's Bash tool, its PowerShell tool on Windows, and its Monitor tool, so a command can't slip past by going through a different one.

Everything else goes through untouched, including anything that only reads or mentions a migration: `grep ... | head`, `cat`, commit messages and PR bodies (heredocs included), and scripts that edit a doc which happens to talk about migrations.

## Risk levels

| Level | What counts |
|---|---|
| High | `DROP TABLE`, `DROP COLUMN`, `DROP DATABASE`/`SCHEMA`, `TRUNCATE`, `DELETE` or `UPDATE` that hits every row (`WHERE 1=1` counts), commands that undo, reset, push or wipe |
| Medium | `DROP INDEX`, `DROP CONSTRAINT`, column type changes, renames, emptying a migration or deleting part of one, running pending migrations |
| Low | A migration with nothing destructive in it |

Each risky command says why: "it undoes applied migrations, and their down steps usually drop things", "it pushes the schema straight to the database and can drop data to make it match", and so on.

To keep it quiet:

- ORM calls are named after the SQL they run. `queryRunner.dropColumn`, `remove_column`, `RemoveField`, `op.drop_column` and `migrationBuilder.DropColumn` all show up as `DROP COLUMN`.
- For a whole migration file it reads only the part that runs forward, everything before `down()` or `-- +goose Down`, because the undo half always drops what the forward half created. Undo files (`.down.sql`, Flyway's `U2__x.sql`) are Low risk for the same reason.
- `DROP TABLE` inside a SQL comment doesn't count.
- When Claude edits a migration, the question reminds you that editing one that already ran won't change the database.

## A batch of migrations

When Claude is writing several migration files, pick "Yes to all files, 15 min". For the next 15 minutes ordinary migration file changes go through without asking. High-risk ones still ask, and commands always ask.

## Turning it off

- `/migration-guard off` turns it off for this session; `/migration-guard off 30` for 30 minutes.
- `/migration-guard on` turns it back on. So does restarting Claude Code, so it can't stay off by accident.
- While it's off, the status line says so, and everything that went through still shows up in the history.
- Only you can do this. If Claude (or a script, or another mod) sends the command, it's refused.
- For good: set `mode` to `off` in `/config`, or delete the folder.

## History

Type `/migration-guard` to see what it asked and what you answered, newest first:

```
Last 3 of 3 (1 blocked). /migration-guard all shows 300, /migration-guard clear empties it.
2026-10-04 20:56  blocked (nobody answered)  [medium]  run a package script that migrates: npm run migration:run  in .../acme/api
2026-10-04 20:41  went through (yes to all files)  [low]  write a migration file: .../db/migrations/0043_add_index.sql  in .../acme/api
2026-10-04 20:40  Yes to all files, 15 min  [low]  write a migration file: .../db/migrations/0042_orders.sql  in .../acme/api
```

It also lists the changes that went through without a question because of an earlier "Yes for this file" or "Yes to all files", so you can see what happened while you weren't looking. It keeps the last 300, in the store Claude Code gives each mod (not a file in your project), with passwords and tokens in commands masked. Set `keepHistory` to `off` if you don't want it.

## Install

One command. Claude Code loads any mod it finds in `~/.claude/skills/`, so there's nothing else to set up:

```bash
git clone https://github.com/balen-abd/claude-migration-guard ~/.claude/skills/migration-guard
```

On Windows, in PowerShell:

```powershell
git clone https://github.com/balen-abd/claude-migration-guard "$HOME\.claude\skills\migration-guard"
```

Check it's on:

```bash
claude -p /migration-guard
```

It should print `migration-guard: Nothing asked yet.` If you get anything else, run `claude --debug` and look for a migration-guard line saying why it didn't load.

You need Claude Code 2.1.287 or newer (`claude --version`). Mods are early access: older builds, which includes the stable channel at the time of writing (2.1.285), can have them switched off. Either update, or add `"CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1"` to the `env` block of `~/.claude/settings.json`.

Update: `git -C ~/.claude/skills/migration-guard pull`. An open session picks it up, and any "Yes for this file" answers start over.

Remove: delete the folder.

Keeping mods somewhere else? Point `CLAUDE_CODE_PLUGIN_DIRS` at the folder in the `env` block of `~/.claude/settings.json`, or use `claude --plugin-dir <folder>` for one session. Use one way, not two, or every question comes twice.

## Settings

In `/config`, under migration-guard:

| Setting | Default | |
|---|---|---|
| `mode` | `always` | `destructive-only` asks only when something destructive or risky shows up; `off` never asks |
| `extraPathPattern` | | a regex for migration paths it misses, e.g. `schema/changes/` |
| `extraCommandPattern` | | a regex for commands it misses, e.g. `./scripts/deploy-db.sh` |
| `keepHistory` | `on` | `off` keeps no history at all |

If a pattern isn't a valid regex, it tells you when the session starts and in `/migration-guard`, instead of quietly ignoring it.

Or in `~/.claude/settings.json`. The key is `migration-guard@skills-dir` for the install above, and `migration-guard` if you load it with `CLAUDE_CODE_PLUGIN_DIRS` or `--plugin-dir`:

```json
{
  "pluginConfigs": {
    "migration-guard@skills-dir": {
      "options": { "mode": "destructive-only", "extraPathPattern": "schema/changes/" }
    }
  }
}
```

Claude Code reads these from your user settings (or `--settings`), not from a project's `.claude/settings.json`, so a repo can't change them behind your back.

## Is it safe?

Don't take my word for it. It's small enough to check:

- About 1,300 lines of TypeScript in `hooks/`. `detect.ts` decides what counts, `question.ts` is the wording, `history.ts` is `/migration-guard`, `register.ts` wires it into Claude Code.
- Mods run in their own environment, with no Node. They can't touch the disk, the network or other processes except through Claude Code's `$` API, and `claude plugin validate .` lists every `$` call a mod makes. This one asks you (`$.ui.ask`, `$.ui.toast`, `$.ui.status`), reads the time and the folder name for the history, keeps the history in its own store (`$.store`), and adds the `/migration-guard` command. It also hooks `AskUserQuestion`, but only to touch its own questions (see below). Nothing reads your files, runs anything, or sends anything anywhere:
  ```
  > ./register.ts hooks: session.start, tool.call{tool=AskUserQuestion}, command.run{command=migration-guard}, tool.call{tool=Write}, tool.call{tool=Edit}, tool.call{tool=/"^(Bash|PowerShell|Monitor)$"/}, tool.call{tool=/"^mcp__"/}
  > ./register.ts calls: $.clock.now (via confirm, guardCommand, remember, stateLine), $.command.register, $.session.cwd (via remember), $.store.get (via guardCommand, remember), $.store.set (via guardCommand, remember), $.ui.ask (via askPerson), $.ui.status (via confirm, guardCommand), $.ui.toast
  ```
- If nobody answers, the change is blocked. That covers `claude -p` and CI, a dismissed question, and one more case I only found by testing live. In VS Code, Claude Code's question dialog **answers itself after about 30 seconds** with nobody at the keyboard, and it picked "Yes". The guard now recognizes that kind of answer (the dialog marks it) and treats it as no answer, and No is the first option in case anything picks the first one.
- In VS Code the question can sit behind a notification that says "Claude is requesting permission to use AskUserQuestion". Click View to see it.
- If the guard itself crashes on a migration file or a migration command, it blocks too. In `destructive-only` mode a safe migration goes through without a question, headless or not.
- It doesn't time out on you. Claude Code pauses a hook's clock while it waits for your answer.
- Subagents go through the same guard.

## What it won't catch

- Migrations run from inside your own script (`./deploy.sh`), or by your app when it starts (TypeORM's `migrationsRun: true` and the like). Add the script to `extraCommandPattern`.
- A migration path built at runtime when the command never says "migrations" (`rm $DIR/x.sql`).
- MCP tools with unusual names. It goes by the tool's name (`apply_migration`, `execute_sql`, `run_sql`, `write_file`...) and what's in the arguments.
- Another mod that answers Claude Code's question dialog for you. Only install mods you trust.
- Anything you run yourself. It guards Claude, not your terminal.
- It reads up to 1 MB per check, so in `destructive-only` mode something past that point in a huge file won't be scanned.
- It doesn't work at all if it doesn't load: an old Claude Code, or a future update that changes the mods API. That's what "Check it's on" and the weekly CI run are for.

It doesn't replace backups. Keep them, and give Claude a database user that can't drop things in production.

## Tests

```bash
claude plugin validate --strict .
claude plugin test .
```

99 tests. CI runs them on Linux, macOS and Windows, against 2.1.287 and the latest Claude Code, every week.

To see if it's actually worth having, I replayed every tool call from 365 of my own past Claude Code sessions through it: 26,157 shell commands and 682 file writes and edits. It would have asked 46 times. 21 were migration files Claude wrote or edited, 23 were migration files changed from the shell or by a Python script, and 2 were real `npm run migration:run` runs. As far as I can tell only one was a false alarm: deleting from a scratch copy of the migrations folder. The other 26,000-odd commands went through without a word.

I also ran it for real. By hand on 2.1.287: no, yes, "Yes for this file", and a subagent's write. Headless with `claude -p` on 2.1.289, installed with the one `git clone` above: a destructive migration write and `npm run migration:run` were blocked, an ordinary file went through, `destructive-only` set in settings let a safe migration through, and `/migration-guard` showed it all.

## License

MIT
