# Changelog

## 0.1.1 (2026-10-05)

- `sed -i` and `perl -pi` no longer ask when only their script mentions a migration (`sed -i 's/a migration/the migration/' notes.txt`). The files they edit, and lists piped in with `xargs`, still count. Found while recording the demo; the replay of 26,168 real commands asks about the same 47 things as before.

## 0.1.0 (2026-10-04)

First release.

- Installs with one `git clone` into `~/.claude/skills/`; `claude -p /migration-guard` checks it's on.
- Asks before Claude writes or edits a migration file, runs a migration, changes migration files from the shell or from a Python/Node script, runs SQL straight against a database, wipes one (`dropdb`, `docker compose down -v`), or uses an MCP server that migrates or runs destructive SQL.
- Watches Bash, the PowerShell tool on Windows, Monitor, and MCP tools.
- Says so when a pattern setting isn't a valid regex, instead of ignoring it quietly.
- Shows a risk level (High, Medium, Low) and what each finding does, worst first. Risky commands say why.
- No is the first option, and every option says what it does. "Yes for this file" and "Yes to all files, 15 min" for batches. High-risk changes still ask, and commands always ask.
- `/migration-guard` shows what it asked and what you answered, including what went through under an earlier yes. Passwords are masked; `keepHistory: off` keeps nothing.
- `/migration-guard off [minutes]` and `on`, which only work when you type them; `mode: off` in `/config` turns it off for good.
- Blocks when nobody answers: `claude -p`, CI, a dismissed question, and Claude Code's dialog answering itself after about 30 seconds with nobody at the keyboard. Also blocks when the guard itself fails on a migration.
- Stays quiet on commit messages, PR bodies, read-only pipelines (`grep ... | head`), scripts that only mention migrations, and folders that only start with "migration". Over 26,157 real commands from 365 sessions it would have asked 46 times, with one false alarm.
