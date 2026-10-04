import type { EngineInterface, Register } from 'claude-code'
import {
  approvalKey,
  classifyCommand,
  classifyMcpCall,
  findDestructive,
  isEffectivelyEmpty,
  isMigrationPath,
  isUndoFile,
  looksMigrationRelated,
  removedBuild,
  safeRegex,
  shortPath,
  undoFileNote,
  usesHashComments,
  type Finding,
} from './detect'
import { HISTORY_KEY, append, asEntries, render, type Entry } from './history'
import { ALL_WINDOW_MS, NO, YES, YES_ALL, YES_COMMAND, YES_FILE, describeOption, levelOf, optionsFor, questionFor, type Ask } from './question'

// "Yes for this file/command": the key, and the destructive kinds the person
// had seen. A new kind asks again. A reload of the mod starts it over.
const approved = new Map<string, Set<string>>()
// "Yes to all files": until when migration file changes that aren't high risk go through.
let allowAllUntil = 0

const EDIT_HINT = "If it already ran, editing it won't change the database."

// The history behind /migration-guard lives only in the store, read fresh on
// every write: several Claude Code sessions can share it, and a copy kept here
// would bring back what another session cleared.
let keepHistory = true
let lastWrite: Promise<void> = Promise.resolve()

/** One history write at a time in this session, so two at once can't lose one. */
async function takeTurn(): Promise<() => void> {
  const before = lastWrite
  let release = () => {}
  lastWrite = new Promise<void>((resolve) => {
    release = resolve
  })
  await before
  return release
}

/** Writes down what happened. History is a convenience: it never blocks or breaks the guard. */
async function remember($: EngineInterface, ask: Ask, answer: string) {
  if (!keepHistory) return
  const done = await takeTurn()
  try {
    const list = asEntries(await $.store.get(HISTORY_KEY))
    const cwd = await $.session.cwd()
    const at = await $.clock.now()
    const entry: Entry = { at, project: shortPath(cwd), what: ask.what, target: ask.target, risk: levelOf(ask), labels: ask.findings.map((f) => f.label), answer }
    await $.store.set(HISTORY_KEY, append(list, entry))
  } catch {
    // A store or clock that isn't there (a test, an old build) just means no history.
  } finally {
    done()
  }
}

// The off switch: /migration-guard off [minutes] until when, Infinity for "until on".
// Per session, and a reload of the mod turns it back on, so it can't stay off by accident.
let offUntil = 0

// The guard's own questions while they're on screen, so the AskUserQuestion
// hook below touches only those and leaves everyone else's alone.
const ourQuestions = new Set<string>()

/**
 * Asks the person and resolves to what they picked or typed, or undefined
 * when nobody really answered (dismissed, headless, or the dialog answered
 * itself while they were away; the AskUserQuestion hook turns that into no
 * answer).
 */
async function askPerson($: EngineInterface, ask: Ask): Promise<string | undefined> {
  const { header, question } = questionFor(ask)
  ourQuestions.add(question)
  try {
    return await $.ui.ask(question, { header, options: optionsFor(ask).map((o) => o.label) })
  } catch {
    return undefined
  } finally {
    ourQuestions.delete(question)
  }
}

/** Asks the person; resolves to a deny reason, or undefined when they said yes. */
async function confirm($: EngineInterface, ask: Ask) {
  if (offInSettings) return undefined
  if (offUntil > 0) {
    if (offUntil === Infinity || offUntil > (await $.clock.now())) {
      await remember($, ask, 'went through (guard was off)')
      return undefined
    }
    offUntil = 0 // a timed "off" ran out
    $.ui.status(undefined)
  }
  const seen = approved.get(ask.key)
  if (seen && ask.findings.every((f) => seen.has(f.label))) {
    await remember($, ask, 'went through (said yes for it earlier)')
    return undefined
  }
  if (ask.kind === 'file' && allowAllUntil > 0 && levelOf(ask) !== 'high' && allowAllUntil > (await $.clock.now())) {
    await remember($, ask, 'went through (yes to all files)')
    return undefined
  }

  const answer = await askPerson($, ask)
  if (answer === undefined) {
    await remember($, ask, 'blocked (nobody answered)')
    return `${$.plugin.name}: no confirmation for "${ask.target}" (the question was dismissed, or nobody was there to answer). Do not retry; ask the user how to proceed.`
  }
  await remember($, ask, answer === YES || answer === YES_FILE || answer === YES_COMMAND || answer === YES_ALL || answer === NO ? answer : `"${answer}"`)

  if (answer === YES) return undefined
  if (answer === YES_FILE || answer === YES_COMMAND) {
    approved.set(ask.key, new Set([...(seen ?? []), ...ask.findings.map((f) => f.label)]))
    return undefined
  }
  if (answer === YES_ALL) {
    allowAllUntil = (await $.clock.now()) + ALL_WINDOW_MS
    return undefined
  }
  $.ui.toast(`blocked: ${ask.target}`)
  const said = answer === NO ? '' : ` They said: "${answer}"`
  return `${$.plugin.name}: the user did not allow Claude to ${ask.what} (${ask.target}).${said} Do not retry or work around it; follow what they said, or ask how they want to proceed.`
}

// Settings that were filled in but aren't valid regular expressions, so they do nothing.
let badSettings: string[] = []

/** A warning line for settings that are being ignored, or nothing. */
function settingsWarning(): string {
  return badSettings.length > 0 ? `${badSettings.join(' and ')} in /config isn't a valid regular expression, so it's ignored.` : ''
}

// The guard turned off for good in /config (mode: off).
let offInSettings = false

/** One line on whether the guard is on, for the top of /migration-guard. */
async function stateLine($: EngineInterface): Promise<string> {
  if (offInSettings) return 'The guard is off (mode: off in /config).'
  if (offUntil === Infinity) return 'The guard is off until you type /migration-guard on.'
  if (offUntil === 0) return ''
  const left = offUntil - (await $.clock.now())
  return left > 0 ? `The guard is off for ${Math.ceil(left / 60_000)} more min. /migration-guard on turns it back on.` : ''
}

/**
 * /migration-guard: the history, or the off switch. Only the person can flip
 * the switch: a command that didn't come from their own keyboard (Claude, a
 * script, another plugin) is refused.
 */
async function guardCommand($: EngineInterface, args: string | undefined, fromPerson: boolean): Promise<string> {
  const [word = '', minutes] = (args ?? '').trim().split(/\s+/)
  const lines = [settingsWarning()]
  if (word === 'off' || word === 'on') {
    if (!fromPerson) return 'Only you can turn the guard off or on, by typing /migration-guard yourself.'
    const now = await $.clock.now()
    const span = Number(minutes)
    if (word === 'off') {
      offUntil = Number.isFinite(span) && span > 0 ? now + span * 60_000 : Infinity
      const until = offUntil === Infinity ? 'until you turn it back on' : `for ${span} min`
      $.ui.status(`migration-guard: off ${offUntil === Infinity ? '' : `for ${span} min`}`.trim())
      await remember($, { kind: 'command', key: '', what: 'turn the guard off', target: until, findings: [] }, 'by you')
      return `The guard is off ${until}. Migration changes go through without asking, and still show up here. /migration-guard on turns it back on.`
    }
    offUntil = 0
    $.ui.status(undefined)
    await remember($, { kind: 'command', key: '', what: 'turn the guard on', target: 'now', findings: [] }, 'by you')
    return 'The guard is on again.'
  }
  lines.push(await stateLine($))
  if (!keepHistory) return [...lines, 'History is off (keepHistory in /config).'].filter(Boolean).join('\n')
  const done = await takeTurn()
  try {
    if (word === 'clear') {
      await $.store.set(HISTORY_KEY, [])
      return [...lines, 'History cleared.'].filter(Boolean).join('\n')
    }
    lines.push(render(asEntries(await $.store.get(HISTORY_KEY)), word === 'all' ? Number.MAX_SAFE_INTEGER : 20))
    return lines.filter(Boolean).join('\n')
  } finally {
    done()
  }
}

/**
 * When a guard hook itself fails, Claude Code would run the tool unguarded.
 * Block instead if the call is about migrations; let anything else through.
 */
function failClosed(about: boolean, name: string) {
  return about
    ? { deny: `${name}: the guard hit an internal error, so this was blocked to be safe. Ask the user to run it themselves, or to check the mod.` }
    : undefined
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text
}

/**
 * How a command shows in the question: whole when it's one short line;
 * otherwise just the part that matters, on one line, with "..." when that
 * part isn't where the command starts.
 */
function commandTarget(command: string, part: string): string {
  if (!command.includes('\n') && command.length <= 120) return command
  const shown = clip(part.replace(/\s+/g, ' ').trim(), 113)
  return shown.startsWith('...') || command.trimStart().startsWith(part.trim().slice(0, 20)) ? shown : `... ${shown}`
}

/** What a file's own path says: an undo file only runs on rollback, so its drops are expected. */
function fileFindings(path: string, findings: () => Finding[]): { findings: Finding[]; note?: string } {
  return isUndoFile(path) ? { findings: [], note: undoFileNote() } : { findings: findings() }
}

export const register: Register = (on, options) => {
  const onlyDestructive = options.mode === 'destructive-only'
  const extraPath = safeRegex(options.extraPathPattern)
  const extraCommand = safeRegex(options.extraCommandPattern)
  keepHistory = options.keepHistory !== 'off'
  offInSettings = options.mode === 'off'
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== ''
  badSettings = [
    ...(filled(options.extraPathPattern) && !extraPath ? ['extraPathPattern'] : []),
    ...(filled(options.extraCommandPattern) && !extraCommand ? ['extraCommandPattern'] : []),
  ]

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'migration-guard',
      description: 'What migration-guard asked and what you answered; off/on to pause it',
      argumentHint: '[all | clear | off [minutes] | on]',
    })
    const warning = settingsWarning()
    if (warning) $.ui.toast(`migration-guard: ${warning}`)
    return next(e)
  })

  // The guard's own questions, on their way to the dialog and back. Claude Code's
  // dialog answers itself after a while with nobody at the keyboard (it picked
  // "Yes" in VS Code on 2.1.289) and marks the result with afkTimeoutMs; that
  // answer is turned into no answer, so the change is blocked. On the way in,
  // each option gets its one-line description, which $.ui.ask leaves empty.
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const first = e.questions[0]
    if (!first || !ourQuestions.has(first.question)) return next(e)
    const options = first.options.map((o) => ({ ...o, description: describeOption(o.label) || o.description }))
    const r = await next({ ...e, questions: [{ ...first, options }, ...e.questions.slice(1)] })
    if (r.deny !== undefined || !r.result) return r
    const result = r.result as { answers?: Record<string, unknown>; response?: unknown; afkTimeoutMs?: unknown }
    if (result.afkTimeoutMs !== undefined) return { deny: 'Nobody answered: the question timed out with nobody at the keyboard.' }
    // What the person typed instead of picking an option counts as their answer.
    const typed = typeof result.response === 'string' ? result.response.trim() : ''
    const answers = result.answers ?? {}
    if (typed && typeof answers[first.question] !== 'string') {
      return { ...r, result: { ...result, answers: { ...answers, [first.question]: typed } } }
    }
    return r
  })

  // The person's own Enter, at the terminal or through a bridge to their own device.
  on('command.run', { command: 'migration-guard' }, async ($, e) => ({
    text: await guardCommand($, e.args, e.origin.kind === 'composer' || e.origin.kind === 'bridge'),
  }))

  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    if (!isMigrationPath(e.file_path, extraPath)) return next(e)
    const found = isEffectivelyEmpty(e.content, e.file_path)
      ? { findings: [{ label: 'Empties the file', snippet: '' }] }
      : fileFindings(e.file_path, () => findDestructive(e.content, { skipDown: true, hashComments: usesHashComments(e.file_path) }))
    if (onlyDestructive && found.findings.length === 0) return next(e)
    const deny = await confirm($, {
      kind: 'file',
      key: approvalKey(e.file_path),
      what: 'write a migration file',
      target: shortPath(e.file_path),
      ...found,
    })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : (failClosed(isMigrationPath(e.file_path, extraPath) || looksMigrationRelated(e.content), $.plugin.name) ?? next(e)),
  )

  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    if (!isMigrationPath(e.file_path, extraPath)) return next(e)
    // Deleting the text outright, or dropping a CREATE INDEX/TABLE and keeping the rest.
    const emptied = e.new_string.trim() === '' && e.old_string.trim() !== ''
    const gone = emptied ? e.old_string.trim().split('\n')[0]?.slice(0, 80) : removedBuild(e.old_string, e.new_string)
    const found =
      gone !== undefined
        ? { findings: [{ label: 'Removes code', snippet: gone ?? '' }] }
        : fileFindings(e.file_path, () => findDestructive(e.new_string, { hashComments: usesHashComments(e.file_path) }))
    if (onlyDestructive && found.findings.length === 0) return next(e)
    const deny = await confirm($, {
      kind: 'file',
      key: approvalKey(e.file_path),
      what: 'edit a migration file',
      target: shortPath(e.file_path),
      hint: EDIT_HINT,
      ...found,
    })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : (failClosed(isMigrationPath(e.file_path, extraPath) || looksMigrationRelated(e.new_string), $.plugin.name) ?? next(e)),
  )

  // Bash, the PowerShell tool on Windows, and Monitor all run shell commands.
  on('tool.call', { tool: /^(Bash|PowerShell|Monitor)$/ }, async ($, e, next) => {
    const command = 'command' in e && typeof e.command === 'string' ? e.command : ''
    const hit = classifyCommand(command, { extra: extraCommand, extraPath, powershell: String(e.tool) === 'PowerShell' })
    if (!hit) return next(e)
    if (onlyDestructive && !hit.risky) return next(e)
    const deny = await confirm($, {
      kind: 'command',
      key: command,
      what: hit.reason,
      target: commandTarget(command, hit.part),
      findings: hit.findings,
      note: hit.note,
      baseRisk: hit.risky ? 'high' : 'medium',
    })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) =>
    next.called ? next(e) : (failClosed('command' in e && typeof e.command === 'string' && looksMigrationRelated(e.command), $.plugin.name) ?? next(e)),
  )

  // MCP servers: database ones (Supabase, Neon, Prisma...) and ones that write files.
  on('tool.call', { tool: /^mcp__/ }, async ($, e, next) => {
    const args = Object.fromEntries(Object.entries(e).filter(([key]) => !['tool', 'tool_use_id', 'agentId'].includes(key)))
    const hit = classifyMcpCall(String(e.tool), args, extraPath)
    if (!hit) return next(e)
    if (onlyDestructive && !hit.risky && hit.findings.length === 0) return next(e)
    const deny = await confirm($, {
      kind: hit.kind,
      key: hit.key,
      what: hit.reason,
      target: hit.target,
      findings: hit.findings,
      note: hit.note || undefined,
      baseRisk: hit.kind === 'file' ? undefined : hit.risky ? 'high' : 'medium',
    })
    return deny ? { deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : (failClosed(looksMigrationRelated(JSON.stringify(e)), $.plugin.name) ?? next(e))))
}
