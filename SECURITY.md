# Security

## What the mod can touch

The tool call Claude is about to make: the file path and new text for a Write or Edit, the command for Bash, PowerShell or Monitor, and the arguments of an MCP tool call. It reads nothing from disk, makes no network requests, runs no commands, and sends no telemetry.

It also hooks `AskUserQuestion`, and only touches the questions it asked itself: it adds a one-line description to each option, and if Claude Code's dialog answered on its own because nobody was at the keyboard (the result carries `afkTimeoutMs`), it turns that answer into no answer, so the change is blocked. Every other question passes through untouched.

For `/migration-guard` it keeps a history of what it asked and what you answered in the store Claude Code gives each mod: the last 300 entries, with passwords and tokens in commands masked. `keepHistory: off` turns that off, and `/migration-guard clear` empties it. `/migration-guard off` and `on` only work when you type them; the same command coming from Claude, a script or another mod is refused.

Mods run in their own environment with no Node, so the only way out is Claude Code's `$` API. `claude plugin validate .` lists every hook and `$` call; for this mod it prints:

```
> ./register.ts hooks: session.start, tool.call{tool=AskUserQuestion}, command.run{command=migration-guard}, tool.call{tool=Write}, tool.call{tool=Edit}, tool.call{tool=/"^(Bash|PowerShell|Monitor)$"/}, tool.call{tool=/"^mcp__"/}
> ./register.ts calls: $.clock.now (via confirm, guardCommand, remember, stateLine), $.command.register, $.session.cwd (via remember), $.store.get (via guardCommand, remember), $.store.set (via guardCommand, remember), $.ui.ask (via askPerson), $.ui.status (via confirm, guardCommand), $.ui.toast
```

## If you find a way around it

A command, file change or MCP call that touches migrations without the question showing up, or a question that lets a change through without you answering, is a bug. Please open an issue with the exact command or file path (strip anything private). For something you'd rather not post publicly, message [@balen_abda](https://x.com/balen_abda) on X.
