// What was asked and what you answered, kept in Claude Code's own store for
// this mod (not a file in your project) and shown by /migration-guard.

import type { Level } from './detect'

export type Entry = {
  /** When, in ms. */
  at: number
  /** The folder Claude was working in. */
  project: string
  /** "write a migration file", "run prisma", ... */
  what: string
  target: string
  risk: Level
  labels: string[]
  /** What the person picked or typed, or why nobody was asked. */
  answer: string
}

export const HISTORY_KEY = 'history'
export const HISTORY_LIMIT = 300

/** Passwords and tokens in commands never reach the store. */
export function redact(text: string): string {
  const out = text
    .replace(/\b([a-z][\w+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi, '$1***@') // postgres://user:secret@host
    .replace(/\b([A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|TOKEN|SECRET|API_?KEY)[A-Z0-9_]*)=("[^"]*"|'[^']*'|[^\s'"]+)/gi, '$1=***')
    .replace(/(--password\s)("[^"]*"|'[^']*'|[^\s'"]+)/gi, '$1***')
  // mysql -psecret: only for the MySQL tools, where -p glued to a value is the password
  return /\b(mysql|mariadb|mysqladmin|mysqldump)\b/i.test(out) ? out.replace(/(\s-p)(?=[^\s-])("[^"]*"|'[^']*'|\S+)/g, '$1***') : out
}

/** Adds an entry and drops the oldest past the limit. */
export function append(list: readonly Entry[], entry: Entry): Entry[] {
  const next = [...list, { ...entry, target: redact(entry.target).slice(0, 200) }]
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
}

/** Reads what the store holds, ignoring anything that isn't a list of entries. */
export function asEntries(value: unknown): Entry[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is Entry => typeof v === 'object' && v !== null && typeof (v as { at?: unknown }).at === 'number')
}

const pad = (n: number) => String(n).padStart(2, '0')

function when(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The newest `count` entries, newest first, one line each, for /migration-guard. */
export function render(list: readonly Entry[], count: number): string {
  if (list.length === 0) return 'Nothing asked yet.'
  const shown = list.slice(-count).reverse()
  const lines = shown.map((e) => {
    const found = e.labels.length > 0 ? ` (${e.labels.join(', ')})` : ''
    return `${when(e.at)}  ${e.answer}  [${e.risk}]  ${e.what}: ${e.target}${found}  in ${e.project}`
  })
  const blocked = list.filter((e) => /^(No|blocked)/.test(e.answer) || e.answer.startsWith('"')).length
  const head = `Last ${shown.length} of ${list.length} (${blocked} blocked). /migration-guard all shows ${HISTORY_LIMIT}, /migration-guard clear empties it.`
  return [head, ...lines].join('\n')
}
