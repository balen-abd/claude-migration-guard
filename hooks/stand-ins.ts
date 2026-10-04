// Stand-ins for the person and the engine's tools, shared by the tests.

import type { On } from 'claude-code'

/**
 * Stands in for the person: answers each question with `answers` (one label for
 * all, or a list used in order), recording what was asked and offered.
 */
export function person(on: On, answers: string | string[], asked: string[], headers: string[] = [], offered: string[][] = []) {
  const queue = Array.isArray(answers) ? [...answers] : []
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0] as { question: string; header: string; options: { label: string }[] }
    asked.push(String(q.question))
    headers.push(String(q.header))
    offered.push(q.options.map((o) => o.label))
    const label = Array.isArray(answers) ? (queue.shift() ?? 'No') : answers
    return { result: { questions: e.questions, answers: { [q.question]: label } } }
  })
}

/**
 * Stands in for nobody being there: Claude Code's question dialog answers
 * itself after a while idle, picking the first option, and marks it with
 * afkTimeoutMs. Seen live in VS Code on 2.1.289.
 */
export function away(on: On, asked: string[] = []) {
  on('tool.call', { tool: 'AskUserQuestion' }, (_$, e) => {
    const q = e.questions[0] as { question: string; options: { label: string }[] }
    asked.push(String(q.question))
    return { result: { questions: e.questions, answers: { [q.question]: q.options[0]?.label ?? 'Yes' }, afkTimeoutMs: 30_000 } }
  })
}

/** Stands in for the engine's Write and Edit tools, recording what landed. */
export function disk(on: On, wrote: string[]) {
  on('tool.call', { tool: 'Write' }, (_$, e) => {
    wrote.push(e.file_path)
    return { result: { type: 'create' as const, filePath: e.file_path, content: e.content, structuredPatch: [], originalFile: null } }
  })
  on('tool.call', { tool: 'Edit' }, (_$, e) => {
    wrote.push(e.file_path)
    return { result: { filePath: e.file_path, oldString: e.old_string, newString: e.new_string, originalFile: '', structuredPatch: [], userModified: false, replaceAll: false } }
  })
}

/** Stands in for the tools that run commands, recording what ran. */
export function shell(on: On, ran: string[]) {
  on('tool.call', { tool: 'Bash' }, (_$, e) => {
    ran.push(e.command)
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('tool.call', { tool: 'Monitor' }, (_$, e) => {
    ran.push(e.command ?? '')
    return { result: { taskId: 't1', timeoutMs: 0 } }
  })
}

/** Stands in for every MCP server, recording which tools were called. */
export function mcp(on: On, called: string[]) {
  on('tool.call', { tool: /^mcp__/ }, (_$, e) => {
    called.push(String(e.tool))
    return { result: 'ok' }
  })
}
