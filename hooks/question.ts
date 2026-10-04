// The words the person sees. Kept apart so they're easy to read, test and change.

import { bySeverity, impactOf, riskOf, type Finding, type Level } from './detect'

export const YES = 'Yes'
export const YES_FILE = 'Yes for this file'
export const YES_COMMAND = 'Yes for this command'
export const YES_ALL = 'Yes to all files, 15 min'
export const NO = 'No'

/** How long "Yes to all files" lasts. High-risk changes still ask inside it. */
export const ALL_WINDOW_MS = 15 * 60_000

const HEADER: Readonly<Record<Level, string>> = { high: 'High risk', medium: 'Medium risk', low: 'Low risk' }

export type Ask = {
  /** A file Claude writes or edits, or a command (shell or MCP). */
  kind: 'file' | 'command'
  /** What "Yes for this file/command" remembers: the file or the exact command. */
  key: string
  /** "write a migration file", "run prisma", ... */
  what: string
  /** The short file path, the command, or the MCP tool, as shown. */
  target: string
  findings: Finding[]
  /** Why it matters when nothing destructive was spotted. */
  note?: string
  /** The command's own risk, used when there are no findings. */
  baseRisk?: Level
  /** One more line worth knowing, shown last. */
  hint?: string
}

export function levelOf(ask: Ask): Level {
  return riskOf(ask.findings, ask.baseRisk)
}

export type Option = { label: string; description: string }

const OPTION: Readonly<Record<string, string>> = {
  [NO]: 'Block it. Claude is told to stop and not work around it.',
  [YES]: 'Allow this once.',
  [YES_FILE]: "Don't ask again for this file, unless something more destructive shows up.",
  [YES_COMMAND]: "Don't ask again for this exact command in this session.",
  [YES_ALL]: 'Ordinary migration file changes go through for 15 minutes. High risk still asks.',
}

/** The one line under an option in the dialog. */
export function describeOption(label: string): string {
  return OPTION[label] ?? ''
}

/**
 * The buttons, No first: anything that picks the first one by default picks
 * the safe one. "Yes to all files" only shows for files that aren't high
 * risk, since it never covers high-risk changes anyway.
 */
export function optionsFor(ask: Ask): Option[] {
  const labels =
    ask.kind === 'command' ? [NO, YES, YES_COMMAND] : levelOf(ask) === 'high' ? [NO, YES, YES_FILE] : [NO, YES, YES_FILE, YES_ALL]
  return labels.map((label) => ({ label, description: OPTION[label] ?? '' }))
}

/** Risk in the header chip; then what was found and what it does, worst first. */
export function questionFor(ask: Ask): { header: string; question: string } {
  const findings = bySeverity(ask.findings)
  const lines = findings.slice(0, 2).map((f) => `${f.label}: ${impactOf(f.label).what}`)
  if (findings.length > 2) lines.push(`+${findings.length - 2} more`)
  // The line it came from, unless the command shown already says it.
  const snippet = findings[0]?.snippet.replace(/[;\s]+$/, '') ?? ''
  const evidence = snippet && !ask.target.includes(snippet) ? ` Found: ${snippet}.` : ''
  const detail = lines.length > 0 ? `${lines.join('; ')}.${evidence}` : `${capitalize(ask.note ?? 'nothing destructive spotted')}.`
  const hint = ask.hint ? ` ${ask.hint}` : ''
  const stop = /[.!?;]$/.test(ask.target) ? '' : '.'
  return {
    header: HEADER[levelOf(ask)],
    question: `Claude wants to ${ask.what}: ${ask.target}${stop} ${detail}${hint} Allow it?`,
  }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
