// Decides what counts as touching a migration, and what in it can destroy
// data. No engine calls in here, so every rule can be tested on its own.

export type Finding = { label: string; snippet: string }

export type CommandHit = {
  /** What the command does, as the question shows it ("run prisma"). */
  reason: string
  /** True when the command can lose data or undo work by its own name. */
  risky: boolean
  /** One short line on why it matters, shown when no destructive SQL was spotted. */
  note: string
  /** Destructive SQL in the command itself. */
  findings: Finding[]
  /** The step that matched, shown when the whole command is too long to read in the question. */
  part: string
}

const NOTE = {
  applies: 'it applies pending migrations to the database',
  wipes: 'it can wipe the database or drop data',
  undoes: 'it undoes applied migrations, and their down steps usually drop things',
  pushes: 'it pushes the schema straight to the database and can drop data to make it match',
  forced: "it's forced, so the tool's own safety checks are skipped",
  history: 'it changes which migrations count as applied, so history can drift',
  sqlDirect: 'it runs straight against the database, with no migration to review',
  sqlFile: "the guard can't see what the file does",
  shellDeletes: 'it deletes migration files; if one already ran, history can drift',
  shellWrites: "it changes migration files outside the file tools, so there's no diff to review",
  scriptWrites: "a script rewrites it, so there's no diff to review",
  volumes: 'any database data in those volumes is gone for good',
  dropDb: 'it deletes the whole database',
  restore: 'it writes a dump into the database',
  restoreClean: 'it drops what is there before restoring',
  mcp: 'it applies the change to the database right away',
  extra: 'you listed it in extraCommandPattern',
  undoFile: "it's an undo file, so it only runs on rollback",
  tooLong: "it's over 1 MB, so the guard can't read all of it",
}

// Even big generated migrations stay well under this. The cap keeps every
// check fast when someone pastes something enormous.
const MAX_SCAN = 1024 * 1024
function capped(text: string): string {
  return text.length > MAX_SCAN ? text.slice(0, MAX_SCAN) : text
}

// ---------------------------------------------------------------- files

const MIGRATION_DIRS: readonly RegExp[] = [
  /(^|[\\/])migrations?[\\/]/i, // migrations/ or migration/ (TypeORM, Prisma, Knex, Supabase, Flyway, EF Core...)
  /(^|[\\/])db[\\/]migrate[\\/]/i, // Rails
  /(^|[\\/])alembic[\\/]versions[\\/]/i, // Alembic
  /(^|[\\/])db[\\/]changelog[\\/]/i, // Liquibase
  /(^|[\\/])db\.changelog[\w.-]*$/i, // Liquibase master changelog
  /(^|[\\/])drizzle[\\/]([^\\/]+\.sql|meta[\\/][^\\/]+\.json)$/i, // drizzle-kit output and its journal
  /(^|[\\/])sqitch[\\/](deploy|revert)[\\/]/i, // Sqitch
  /(^|[\\/])conf[\\/]evolutions[\\/]/i, // Play
]

const CODE_FILE = /\.(p?g?sql|[cm]?[jt]sx?|py|rb|go|rs|php|java|kt|cs|swift|exs?|xml|ya?ml|json)$/i
// Tests and fixtures that sit next to migrations, and code other people ship.
const NOT_OURS = /\.(spec|test)\.[^.\\/]+$|_(test|spec)\.\w+$|[\\/]test_[^\\/]+\.py$|[\\/](__tests__|node_modules|vendor|site-packages)[\\/]/i
// golang-migrate's .down.sql, Diesel's down.sql, Flyway's U2__undo.sql
const UNDO_FILE = /(^|[\\/._-])down\.sql$|(^|[\\/])U\d+(_\d+)*__[^\\/]*\.sql$/i

/** A migration file. Docs, READMEs and tests that live in a migrations folder are not. */
export function isMigrationPath(path: string, extra?: RegExp): boolean {
  if (extra?.test(path)) return true
  if (!CODE_FILE.test(path) || NOT_OURS.test(path)) return false
  if (/\.json$/i.test(path) && !/changelog|drizzle/i.test(path)) return false // JSON only for Liquibase and Drizzle
  return MIGRATION_DIRS.some((re) => re.test(path))
}

/** A file that only runs on rollback, where drops are the whole point. */
export function isUndoFile(path: string): boolean {
  return UNDO_FILE.test(path)
}

export function undoFileNote(): string {
  return NOTE.undoFile
}

// ---------------------------------------------------- destructive statements

type Rule = readonly [RegExp, string | ((m: RegExpExecArray) => string)]

const RULES: readonly Rule[] = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE'],
  [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN'],
  // Postgres and MySQL let you leave out COLUMN: ALTER TABLE users DROP email
  [
    /\bALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?[\w."`[\]]+\s+DROP\s+(?!COLUMN\b|CONSTRAINT\b|INDEX\b|KEY\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b|PRIMARY\b|FOREIGN\b|CHECK\b|PARTITION\b)["`[\w]/i,
    'DROP COLUMN',
  ],
  [/\bDROP\s+(UNIQUE\s+)?(INDEX|KEY)\b/i, 'DROP INDEX'], // DROP KEY is MySQL for an index
  [/\bDROP\s+(CONSTRAINT|FOREIGN\s+KEY|PRIMARY\s+KEY)\b/i, 'DROP CONSTRAINT'],
  [/\bDROP\s+PARTITION\b/i, 'DROP PARTITION'],
  [
    /\bDROP\s+(SCHEMA|DATABASE|MATERIALIZED\s+VIEW|VIEW|TYPE|TRIGGER|FUNCTION|PROCEDURE|EXTENSION|SEQUENCE|OWNED|POLICY)\b/i,
    (m) => `DROP ${(m[1] ?? '').toUpperCase().replace(/\s+/g, ' ')}`,
  ],
  [/\bDROP\b[^;]{0,200}?(?<!\bON\s+(DELETE|UPDATE)\s+)\bCASCADE\b/i, 'CASCADE'], // takes everything that depends on it along
  // Several actions in one ALTER: ALTER TABLE users ADD COLUMN a int, DROP b
  [/\bALTER\s+TABLE\b[^;]{0,500}?,\s*DROP\s+(?!CONSTRAINT\b|INDEX\b|KEY\b|DEFAULT\b|NOT\b|IDENTITY\b|EXPRESSION\b|PRIMARY\b|FOREIGN\b|CHECK\b|PARTITION\b)["`[\w]/i, 'DROP COLUMN'],
  [/\bTRUNCATE\b(?!\s*(,|ON\b))/i, 'TRUNCATE'], // not GRANT ... TRUNCATE ON, or a trigger's AFTER TRUNCATE ON
  [/\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b/i, 'ALTER COLUMN TYPE'],
  [/\bMODIFY\s+COLUMN\b|\bALTER\s+TABLE\b[^;]{0,500}?\bMODIFY\s+(?!COLUMN\b)\w/i, 'MODIFY COLUMN'],
  [/\bRENAME\s+((COLUMN\s+)?\S+\s+)?TO\b|\bRENAME\s+TABLE\b/i, 'RENAME'],
  // ORM calls get the same names as the SQL they produce, so the question reads the same everywhere.
  [/\bqueryRunner\.(drop\w*|clearTable|clearDatabase|renameColumn|renameTable|changeColumns?)\b/, (m) => fromMethod(m[1])], // TypeORM
  // Knex, Laravel, Sequelize, node-pg-migrate, db-migrate, Phinx: table.dropColumn(), $table->dropColumn(), pgm.alterColumn()...
  [
    /(?<!queryRunner)(?:\.|::|->)(drop[A-Z]\w*|dropIfExists|remove(?:Column|Index|Constraint|ForeignKey)s?|changeColumn|alterColumn|rename(?:Column|Table))\s*\(/,
    (m) => fromMethod(m[1]),
  ],
  [/\bSchema::drop\s*\(|->drop\(\s*\)/, 'DROP TABLE'], // Laravel, Phinx
  [/(?:->|\.)(change|alter)\(\s*\)/, 'ALTER COLUMN'], // Laravel ->change(), Knex .alter()
  [/\b(drop_table|drop_join_table|remove_columns?|remove_timestamps|remove_index|remove_reference|remove_foreign_key|rename_column|rename_table|change_column)\b/, (m) => fromMethod(m[1])], // Rails
  [/\bt\.(remove|rename)\b/, (m) => (m[1] === 'remove' ? 'DROP COLUMN' : 'RENAME')], // Rails change_table
  [/\bmigrations\.(RemoveField|DeleteModel|AlterField|RenameField|RenameModel|RemoveIndex|RemoveConstraint)\b/, (m) => fromMethod(m[1])], // Django
  [/\b\w*op\.(drop_table|drop_column|drop_index|drop_constraint|alter_column|rename_table)\b/, (m) => fromMethod(m[1])], // Alembic, batch_op too
  [/\bmigrationBuilder\.(Drop\w+|RenameColumn|RenameTable|AlterColumn)\b/, (m) => fromMethod(m[1])], // EF Core
  [/^\s*(remove(?:_if_exists)?\s+:\w+|drop(?:_if_exists)?\s+(table|index|constraint)\()/m, (m) => (/^\s*remove/.test(m[1] ?? '') ? 'DROP COLUMN' : `DROP ${(m[2] ?? '').toUpperCase()}`)], // Ecto
  [/<(dropTable|dropColumn|dropIndex|dropForeignKeyConstraint|dropPrimaryKey|dropUniqueConstraint|dropView|dropSequence|renameColumn|renameTable|modifyDataType)\b/, (m) => fromMethod(m[1])], // Liquibase XML
  [/^\s*-?\s*(dropTable|dropColumn|dropIndex|dropForeignKeyConstraint|renameColumn|renameTable|modifyDataType)\s*:/m, (m) => fromMethod(m[1])], // Liquibase YAML
  [/\.dropDatabase\s*\(\s*\)/, 'DROP DATABASE'], // Mongo
  [/\.drop\s*\(\s*\)/, 'DROP COLLECTION'],
  [/\.deleteMany\s*\(\s*(\{\s*\})?\s*\)|\.deleteFrom\([^)]{0,100}\)\s*\.execute\(|\bknex\(\s*['"][\w.]+['"]\s*\)\s*\.(del|delete)\(\s*\)/, 'DELETE without WHERE'], // Mongo, Prisma, Kysely, Knex
]

/** Maps an ORM method (dropColumn, remove_column, RemoveField...) to the SQL it stands for. */
function fromMethod(raw: string | undefined): string {
  const m = (raw ?? '').replace(/_/g, '').toLowerCase()
  if (/^(droptable(ifexists)?|dropalltables|dropjointable|dropifexists|deletemodel)$/.test(m)) return 'DROP TABLE'
  if (m === 'cleardatabase') return 'DROP DATABASE'
  if (/^(dropcolumns?|removecolumns?|removefield|removetimestamps|drop(timestamps|softdeletes)(tz)?|dropconstrainedforeignid|dropforeignidfor|dropmorphs|dropremembertoken)$/.test(m)) {
    return 'DROP COLUMN'
  }
  if (/^(dropind(ex|exes|ices)|removeindex)$/.test(m)) return 'DROP INDEX'
  if (/^(drop(foreign(keys?)?(constraint)?|primary(key)?|unique(constraints?)?|check(constraints?)?|exclusion(constraints?)?|constraint)|remove(reference|foreignkey|constraint))$/.test(m)) {
    return 'DROP CONSTRAINT'
  }
  if (/^(cleartable|truncate)$/.test(m)) return 'TRUNCATE'
  if (/^rename(column|table|field|model)$/.test(m)) return 'RENAME'
  if (m === 'modifydatatype') return 'ALTER COLUMN TYPE'
  if (/^(changecolumns?|altercolumn|alterfield)$/.test(m)) return 'ALTER COLUMN'
  if (m === 'dropmaterializedview') return 'DROP MATERIALIZED VIEW'
  const object = /^drop(view|schema|database|sequence|function|procedure|trigger|type|extension|policy)$/.exec(m)?.[1]
  return object ? `DROP ${object.toUpperCase()}` : `${raw ?? 'drop'}()` // named as written, with the generic warning
}

export type Level = 'high' | 'medium' | 'low'

// One fixed line per kind of change, so the question never guesses.
const IMPACT: Readonly<Record<string, { level: Level; what: string }>> = {
  'DROP TABLE': { level: 'high', what: 'deletes the table and every row in it' },
  'DROP COLLECTION': { level: 'high', what: 'deletes the collection and its documents' },
  'DROP COLUMN': { level: 'high', what: 'deletes the column and its data' },
  'DROP DATABASE': { level: 'high', what: 'deletes the whole database' },
  'DROP SCHEMA': { level: 'high', what: 'deletes the schema and everything in it' },
  'DROP PARTITION': { level: 'high', what: 'deletes the partition and its rows' },
  'DROP OWNED': { level: 'high', what: 'deletes everything the role owns' },
  CASCADE: { level: 'high', what: 'also drops everything that depends on it' },
  TRUNCATE: { level: 'high', what: 'deletes every row' },
  'DELETE without WHERE': { level: 'high', what: 'deletes every row' },
  'UPDATE without WHERE': { level: 'high', what: 'changes every row' },
  'ALTER COLUMN TYPE': { level: 'medium', what: 'rewrites the column; can lose data and lock the table' },
  'MODIFY COLUMN': { level: 'medium', what: 'rewrites the column; can lose data and lock the table' },
  'ALTER COLUMN': { level: 'medium', what: 'changes a column definition; can lock the table or cut data' },
  RENAME: { level: 'medium', what: 'breaks code that still uses the old name' },
  'DROP INDEX': { level: 'medium', what: 'can make queries slow' },
  'DROP CONSTRAINT': { level: 'medium', what: 'lets bad or duplicate data in' },
  'Empties the file': { level: 'medium', what: 'the migration would do nothing; if it already ran, history can drift' },
  'Removes code': { level: 'medium', what: 'part of the migration is deleted' }, // edits only, and the edit hint covers "if it already ran"
}

/** How bad a finding is, in one short line. Unknown kinds get an honest generic line. */
export function impactOf(label: string): { level: Level; what: string } {
  return IMPACT[label] ?? { level: 'medium', what: 'removes it, and anything that depends on it breaks' }
}

const RANK: Readonly<Record<Level, number>> = { high: 2, medium: 1, low: 0 }

/** Worst first, so the question leads with what matters. */
export function bySeverity(findings: readonly Finding[]): Finding[] {
  return [...findings].sort((a, b) => RANK[impactOf(b.label).level] - RANK[impactOf(a.label).level])
}

/** The overall risk: the worst finding, or the command's own risk when nothing was found. */
export function riskOf(findings: readonly Finding[], commandRisk: Level = 'low'): Level {
  return findings.reduce<Level>((worst, f) => {
    const level = impactOf(f.label).level
    return RANK[level] > RANK[worst] ? level : worst
  }, commandRisk)
}

// A WHERE that matches every row is no WHERE at all: WHERE 1=1, WHERE true, MySQL's WHERE 1.
const REAL_WHERE = /\bWHERE\b(?!\s+(?:1\s*=\s*1|true|1)\s*(?:$|;|\)|LIMIT\b|ORDER\b|RETURNING\b))/i

// Where the forward and undo halves start, written as methods, exports or
// keys at the start of a line, so a "see down()" inside up() doesn't count.
const LEAD = String.raw`^[ \t]*(?:(?:public|protected|private|static|export|async|override|void|function|const|let|var)\s+)*`
const half = (names: string, go: string) =>
  new RegExp(
    `${LEAD}(?:${names})\\s*[(:=]|^[ \\t]*func\\s+${go}[A-Z_]\\w*\\s*\\(|^[ \\t]*(?:module\\.)?exports\\.${go}\\b|^[ \\t]*def\\s+(?:${names})\\b`,
    'm',
  )
const UP = half('up|upgrade|change|Up', 'up')
const DOWN = half('down|downgrade|Down', 'down')
// SQL files keep both halves in one file, split by a comment: goose, dbmate, sql-migrate, MyBatis, Play.
const SQL_DOWN_MARKER = /^[ \t]*(?:--[ \t]*(?:\+goose[ \t]+Down|migrate:down|\+migrate[ \t]+Down|\/\/@UNDO)|#[ \t]*---[ \t]*!Downs)\b/im
// Django's RunSQL(..., reverse_sql=...) is the undo half inside the forward one.
const REVERSE_SQL = /\breverse_sql\s*=\s*(\[[^\]]{0,5000}\]|"""[\s\S]{0,5000}?"""|'''[\s\S]{0,5000}?'''|"[^"\n]{0,5000}"|'[^'\n]{0,5000}')/g

/** The part of a migration that runs forward: everything before down() when up() comes first. */
function forwardPart(text: string): string {
  const up = text.search(UP)
  const down = text.search(DOWN)
  return (up >= 0 && down > up ? text.slice(0, down) : text).replace(REVERSE_SQL, '')
}

/**
 * `-- DROP TABLE users` in a comment is not a drop. A block comment never
 * spans a `;`, so a `/*` inside a string can't swallow the statements after it.
 */
function stripComments(text: string, hash: boolean): string {
  const out = text
    .replace(/\/\*(?:(?!\*\/|\/\*)[^;])*\*\//g, ' ')
    .replace(/(^|\s)--\s[^\n]*/g, '$1')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
  return hash ? out.replace(/(^|\s)#[^\n]*/g, '$1') : out
}

/** Python, Ruby, Elixir and YAML comment with #. */
export function usesHashComments(path: string): boolean {
  return /\.(py|rb|exs?|ya?ml)$/i.test(path)
}

/** Nothing left once comments and blank lines are gone: the migration does nothing. */
export function isEffectivelyEmpty(text: string, path: string): boolean {
  return stripComments(capped(text), usesHashComments(path)).trim() === ''
}

// Statements that build something. Fewer of them after an edit means part of the migration is gone.
const BUILDS =
  /\bCREATE\s+(UNIQUE\s+)?(INDEX|TABLE|VIEW|TRIGGER|FUNCTION|TYPE|SEQUENCE|POLICY)\b|\bADD\s+(COLUMN|CONSTRAINT)\b|\b(createIndex|createTable|addColumn|addIndex|addForeignKey|add_index|add_column|add_reference|create_table|create_index|AddField|CreateModel|AddIndex|AddConstraint|CreateTable|AddColumn|CreateIndex)\b/gi

/** The first building statement the edit takes away, if it takes any away. */
export function removedBuild(before: string, after: string): string | undefined {
  const count = (text: string) => (capped(text).match(BUILDS) ?? []).length
  if (count(after) >= count(before)) return undefined
  const kept = new Set(after.split('\n').map((l) => l.trim()))
  return before.split('\n').find((l) => new RegExp(BUILDS.source, 'i').test(l) && !kept.has(l.trim()))?.trim().slice(0, 80) ?? ''
}

function snippetAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index) + 1
  const end = text.indexOf('\n', index)
  const line = text.slice(start, end < 0 ? undefined : end).trim()
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

/**
 * Statements that can lose data or break running code. With `skipDown`, a
 * whole migration file is read up to its down()/downgrade, because the undo
 * half always drops what up() created and would cry wolf every time.
 * Commands keep their comments: a glob like `/*` would otherwise hide SQL.
 */
export function findDestructive(
  text: string,
  opts: { skipDown?: boolean; keepComments?: boolean; hashComments?: boolean } = {},
): Finding[] {
  let body = capped(text)
  if (opts.skipDown) {
    const marker = body.search(SQL_DOWN_MARKER)
    if (marker >= 0) body = body.slice(0, marker)
  }
  if (!opts.keepComments) body = stripComments(body, opts.hashComments === true)
  if (opts.skipDown) body = forwardPart(body)

  const found: Finding[] = []
  const seen = new Set<string>()
  const add = (label: string, index: number) => {
    if (seen.has(label)) return
    seen.add(label)
    found.push({ label, snippet: snippetAt(body, index) })
  }

  // Every match, not just the first: dropIndex then dropTable must still report DROP TABLE.
  for (const [re, label] of RULES) {
    const all = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    let count = 0
    for (const m of body.matchAll(all)) {
      add(typeof label === 'string' ? label : label(m), m.index ?? 0)
      if (++count >= 50) break
    }
  }

  let offset = 0
  for (const statement of body.split(';')) {
    const del = /\bDELETE\s+FROM\b/i.exec(statement)
    if (del && !REAL_WHERE.test(statement)) add('DELETE without WHERE', offset + del.index)
    const upd = /\bUPDATE\s+(?:ONLY\s+)?["`\w.[\]]+(?:\s+(?:AS\s+)?\w+)?\s+SET\b/i.exec(statement)
    if (upd && !REAL_WHERE.test(statement)) add('UPDATE without WHERE', offset + upd.index)
    offset += statement.length + 1
  }

  return found
}

/** A cheap "could this be about migrations?" test, for failing closed when the guard itself breaks. */
export function looksMigrationRelated(text: string): boolean {
  return /migrat|alembic|changelog|db:(migrate|rollback|drop|reset)|\bDROP\s|\bTRUNCATE\b/i.test(capped(text))
}

// ------------------------------------------------------- reading commands

type Step = { text: string; substitutes: boolean }

/**
 * Splits a command line into steps on && || ; & and newlines (and on | when
 * asked), never inside quotes. `substitutes` notes $( ) or backticks, which
 * run commands even inside an echo.
 */
function splitSteps(command: string, pipes: boolean, powershell: boolean): Step[] {
  const escape = powershell ? '`' : '\\'
  const steps: Step[] = []
  let quote = ''
  let start = 0
  let substitutes = false
  const cut = (end: number) => {
    const text = command.slice(start, end)
    if (text.trim() !== '') steps.push({ text, substitutes })
    substitutes = false
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    const after = command[i + 1] ?? ''
    if (quote === "'") {
      if (c === "'") quote = ''
      continue
    }
    if (c === escape) {
      i++
      continue
    }
    if (!powershell && (c === '`' || (c === '$' && after === '('))) substitutes = true
    if (powershell && c === '$' && after === '(') substitutes = true
    if (quote === '"') {
      if (c === '"') quote = ''
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    let width = 0
    if (c === '\n' || c === ';') width = 1
    else if ((c === '&' || c === '|') && after === c) width = 2
    else if (c === '|' && pipes) width = 1
    else if (c === '&' && after !== '>' && command[i - 1] !== '>') width = 1
    if (width > 0) {
      cut(i)
      start = i + width
      i += width - 1
    }
  }
  cut(command.length)
  return steps
}

// Who reads a heredoc decides what its body is: text (a commit message), a
// script (python, node...), or more shell (bash, ssh, a database client).
const TEXT_READER = /\b(cat|git|gh|glab|echo|printf|tee|less|more|head|tail|wc|jq|yq)\b/
const SCRIPT_READER = /\b(python[\d.]*|node|deno|bun|ruby|perl|php|tsx|ts-node)\b/
const SHELL_READER = /\b(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|xargs|eval|source|docker|podman|kubectl|ssh|patch|git\s+(apply|am))\b/
// A patch says which files it changes in its body, not on the command line.
const APPLIES_PATCH = /\bgit\s+(apply|am)\b|\bpatch\s+(-p\d|-i\b|<)/
const HEREDOC = /<<(-?)[ \t]*(['"]?)([A-Za-z_][\w.-]*)\2/

/**
 * Takes heredoc bodies out of the command line, so a commit message that
 * says "npm run migration:run" isn't a command. A body fed to a shell or a
 * database client stays, since it is more commands. A body fed to python,
 * node and the like goes to `scripts`, judged as code. A body written into a
 * migration (cat > migrations/x.sql <<EOF) goes to `written`, so the question
 * can say what's in it.
 */
function readHeredocs(command: string, extraPath?: RegExp): { text: string; written: string[]; scripts: string[] } {
  const lines = command.split('\n')
  const kept: string[] = []
  const written: string[] = []
  const scripts: string[] = []
  let seen = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    kept.push(line)
    const m = HEREDOC.exec(line)
    if (!m || insideQuotes(line, m.index) || ++seen > 20) continue
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if ((m[1] === '-' ? (lines[j] ?? '').replace(/^\t+/, '') : (lines[j] ?? '')).replace(/\r$/, '') === m[3]) {
        end = j
        break
      }
    }
    if (end < 0) continue // never closed: not a heredoc we understand, keep everything
    if (SHELL_READER.test(line) || DB_CLIENT.test(line)) continue
    const body = lines.slice(i + 1, end).join('\n')
    if (SCRIPT_READER.test(line)) scripts.push(body)
    else if (!TEXT_READER.test(line)) continue
    else if (writesMigration(line, extraPath)) written.push(body)
    i = end - 1 // skip the body; the closing line is kept and is harmless
  }
  return { text: kept.join('\n'), written, scripts }
}

/** Whether `index` sits inside quotes. `$(` starts fresh quoting, as in "$(cat <<'EOF' ...)". */
function insideQuotes(line: string, index: number): boolean {
  const open: string[] = []
  for (let i = 0; i < index; i++) {
    const c = line[i]
    const top = open[open.length - 1]
    if (top === "'") {
      if (c === "'") open.pop()
    } else if (c === '\\') i++
    else if (c === '$' && line[i + 1] === '(') {
      open.push('(')
      i++
    } else if (top === '"') {
      if (c === '"') open.pop()
    } else if (c === ')' && top === '(') open.pop()
    else if (c === '"' || c === "'") open.push(c)
  }
  const top = open[open.length - 1]
  return top === '"' || top === "'"
}

// Commands that only print, search or read: mentioning "migration:run" in them runs nothing,
// and a pipeline made only of them (grep ... | cut ... | head) changes nothing.
const ONLY_MENTIONS =
  /^\s*(echo|printf|grep|egrep|fgrep|rg|ag|ack|findstr|cat|bat|head|tail|cut|sort|uniq|wc|tr|column|nl|less|more|jq|yq|ls|tree|stat|file|diff|cmp|xargs\s+(?:-\S+\s+)*(?:grep|egrep|rg|cat|head|tail|wc|ls|file|stat)|Write-(Output|Host)|Select-String|Get-Content|Get-ChildItem|git\s+(commit|log|show|diff|grep|tag|status|blame|ls-files)|gh\s+(pr|issue)\s+(create|comment|edit|view))\b/i

function onlyMentions(step: Step, powershell: boolean): boolean {
  return !step.substitutes && splitSteps(step.text, true, powershell).every((part) => ONLY_MENTIONS.test(part.text))
}

// ------------------------------------------------------------- commands

// Commands that only look, plan, or write a new migration file.
const READ_ONLY =
  /\b(migration:(show|status|generate|create)|migrate:(status|make|install)|migrate\s+(status|create|new|make|list)|showmigrations|alembic\s+(current|history|heads|check|show|branches|revision)|prisma\s+migrate\s+(status|diff)|ef\s+migrations\s+(list|add|script)|(update|rollback)-?sql)\b|--create-only\b|\bmigrate\b[^|;&\n]{0,200}?\s--(plan|check)\b/i

const WIPE_WORD = /\b(reset|fresh|refresh|drop|purge|flush|wipe|clean|truncate|destroy|nuke|replant|reset_db|truncate_all|dropAll|flywayClean)\b/i
const UNDO_WORD = /\b(revert|rollback|undo|down|downgrade|redo|zero|remove|update\s+0|VERSION=0)\b/i
const PUSH_WORD = /\b(push|sync)\b/i
const FORCE_WORD = /\bforce\b/i
const HISTORY_WORD = /\b(stamp|resolve|repair|fake|baseline|changelog-?sync|mark)\b/i

/** How risky a migration command is by its own words, and the line that says why. */
function riskOfWords(text: string): { risky: boolean; note: string } {
  if (WIPE_WORD.test(text)) return { risky: true, note: NOTE.wipes }
  if (UNDO_WORD.test(text)) return { risky: true, note: NOTE.undoes }
  if (PUSH_WORD.test(text)) return { risky: true, note: NOTE.pushes }
  if (FORCE_WORD.test(text)) return { risky: true, note: NOTE.forced }
  if (HISTORY_WORD.test(text)) return { risky: false, note: NOTE.history }
  return { risky: false, note: NOTE.applies }
}

// Flags with an optional value, as package managers and make take them before the script: --filter api, -C apps/api
const FLAGS = String.raw`(?:--?[\w-]+(?:[=\s][^\s-]\S*)?\s+)`

// Bounded gaps ([^...]{0,200}) instead of .* keep every rule linear on long input.
const RUNNERS: ReadonlyArray<readonly [RegExp, string]> = [
  // Package scripts, workspace flags included: pnpm --filter api db:migrate, npm --prefix api run migrate
  [
    new RegExp(
      String.raw`\b(npm|pnpm|yarn|bun)(\.cmd|\.exe)?\s+(?:${FLAGS}|workspace\s+\S+\s+|run(?:-script)?\s+){0,6}(?!test|lint|check|verify|typecheck|format)[\w:.-]*(migrat|db[-_:]?(reset|drop|rollback|push|wipe))[\w:.-]*`,
      'i',
    ),
    'a package script that migrates',
  ],
  [/\bturbo\s+(?:\S+\s+){0,5}?\S*migrat|\bnx\s+(run|run-many|affected)\b[^|;&\n]{0,200}?[\s:]migrat|\blerna\s+run\s+\S*migrat/i, 'a monorepo task that migrates'],
  [
    new RegExp(String.raw`\b(make|just|task|mage)(\.exe)?\s+${FLAGS}{0,4}[\w:./-]*(migrat|db[-_:]?(reset|drop|rollback|push))[\w:./-]*`, 'i'),
    'a make/just/task target that migrates',
  ],
  [/\b(docker|podman)[- ]compose\b[^|;&\n]{0,200}?\b(run|up)\b[^|;&\n]{0,200}?\bmigrat\w*/i, 'a container that migrates'],
  [/\btypeorm(-ts-node-\w+)?\s+(migration:(run|revert)|schema:(drop|sync))\b/i, 'typeorm'],
  // Any CLI driven by a migrate:/migration: verb, e.g. `node node_modules/typeorm/cli.js migration:run`.
  [/\bmigrat(e|ion):(run|revert|up|down|latest|rollback|reset|fresh|refresh)\b/i, 'migrations'],
  [/\bschema:(drop|sync|update|fresh)\b/i, 'a schema sync'],
  [/\bprisma\s+(migrate\s+(dev|deploy|reset|resolve)|db\s+push)\b/i, 'prisma'],
  [/\bsequelize(-cli)?\s+db:(migrate|drop|seed:undo)/i, 'sequelize'],
  [/\b(rails|rake)\s+db:(migrate|rollback|drop|reset|setup|prepare|schema:load|purge|seed:replant|truncate_all)\b/i, 'a rails db task'],
  [/\balembic\b[^|;&\n]{0,200}?\b(upgrade|downgrade|stamp)\b/i, 'alembic'],
  [/\bflask\s+db\s+(upgrade|downgrade|stamp)\b/i, 'flask-migrate'],
  [/\b(manage\.py|django-admin)\s+(migrate|flush|reset_db)\b/i, 'django migrate'],
  [/\bartisan\s+(migrate|db:wipe)\b/i, 'laravel migrate'],
  [/\bdoctrine:(migrations:(migrate|execute|rollup|version)|schema:(update|drop))\b/i, 'doctrine'],
  [/\bphinx\s+(migrate|rollback)\b|\byii\s+migrate(?!\/(create|history|new))\b|\bcake\s+migrations\s+(migrate|rollback)\b/i, 'php migrations'],
  [/\bflyway\b[^|;&\n]{0,200}?\b(migrate|clean|repair|undo|baseline)\b|\bflyway(Migrate|Clean|Repair)\b/i, 'flyway'],
  [/\bliquibase\b[^|;&\n]{0,200}?\b(update|rollback|drop-?all|changelog-?sync)\b/i, 'liquibase'],
  [/\bdrizzle-kit\s+(push|migrate)\b/i, 'drizzle-kit'],
  [/\bsupabase\s+(db\s+(push|reset)|migration\s+(up|repair|squash))\b/i, 'supabase'],
  [/\bwrangler\s+d1\s+migrations\s+apply\b/i, 'wrangler d1'],
  [/\bhasura\s+(migrate\s+(apply|delete)|metadata\s+apply)\b/i, 'hasura'],
  [/\b(node-pg-migrate|db-migrate)\s+(up|down|redo|reset)\b|\bsqitch\s+(deploy|revert|rebase)\b/i, 'migrations'],
  [/\b(goose|dbmate)\b[^|;&\n]{0,200}?\b(up|up-by-one|up-to|down|down-to|reset|redo|rollback|drop|migrate)\b/i, 'goose/dbmate'],
  [/\bmigrate\b[^|;&\n]{0,200}?\s-(path|source|database)\b[^|;&\n]{0,200}?\b(up|down|drop|force|goto)\b/i, 'golang-migrate'],
  [/\batlas\s+(migrate\s+apply|schema\s+(apply|clean))\b/i, 'atlas'],
  [/\bdotnet\s+ef\s+(database\s+(update|drop)|migrations\s+remove)\b|\b(Update|Drop)-Database\b/i, 'EF Core'],
  [/\bdiesel\s+(migration\s+(run|revert|redo)|database\s+reset)\b/i, 'diesel'],
  [/\bsqlx\s+(migrate\s+(run|revert)|database\s+(drop|reset))\b/i, 'sqlx'],
  [/\bmix\s+ecto\.(migrate|rollback|drop|reset)\b/i, 'ecto'],
  // Hand-rolled ones: node scripts/migrate.ts, python migrate.py, go run ./cmd/migrate up
  [
    /\b(node|tsx|ts-node|bun|deno\s+run|python[\d.]*|ruby|php)\b[^|;&\n]{0,200}?(^|[\s'"\\/])(run[-_])?(migrate|migrations?|migrator)([-_](up|down|latest|all))?\.(m?[jt]s|py|rb|php)\b|\bgo\s+run\s+\S*cmd[\\/]migrate\b/i,
    'a migration script',
  ],
]

// Database clients as commands, not as part of a path or a file name (bitnami/mysql is a chart, mysql.yaml a file).
const DB_CLIENT =
  /(?<![\w.-])(psql|pgcli|mysql|mycli|mariadb|sqlite3|litecli|sqlcmd|Invoke-Sqlcmd|sqlplus|mongosh|mongo|clickhouse-client|cockroach\s+sql|duckdb|usql|turso\s+db\s+shell|pscale\s+shell|wrangler\s+d1\s+execute|prisma\s+db\s+execute|typeorm(-ts-node-\w+)?\s+query|manage\.py\s+dbshell|rails\s+(dbconsole|db)(?=\s|$)|artisan\s+db(?=\s|$))(?![\w./-])/i
// Text after the client that feeds it SQL we can't see: -f x, --file x, < x, \i x, .read x, source x.sql.
// Case matters: psql's -F is a field separator. A -f with a config file is some other tool's flag.
const SQL_FILE_INPUT =
  /\s-f\s*(?!\S*\.(?:ya?ml|json|toml|conf|ini|env|cfg)\b)\S|\s--file[=\s]\S|(?<!<)<(?!<)\s*[^\s<]+|\s-i\s+\S|\\i\s+\S|\\include\s+\S|\.read\s+\S|--stdin\b|\.[sS][qQ][lL]\b|\bsource\s+\S/
// cat x.sql | psql, gunzip -c dump.sql.gz | psql
const SQL_PIPED_IN = /\.sql(\.(gz|bz2|xz|zst))?\b["']?\s*\|/i

const DATA_WIPES: ReadonlyArray<readonly [RegExp, string, string]> = [
  [/\b(docker|podman)[- ]compose\b[^|;&\n]{0,200}?\bdown\b[^|;&\n]{0,200}?\s(-v|--volumes)\b/i, 'delete Docker volumes', NOTE.volumes],
  [/\b(docker|podman)\s+(volume\s+(rm|prune)|system\s+prune\b[^|;&\n]{0,200}?--volumes)\b/i, 'delete Docker volumes', NOTE.volumes],
  [/\bdropdb\b|\bmysqladmin\b[^|;&\n]{0,200}?\bdrop\b/i, 'drop a database', NOTE.dropDb],
  [/\bheroku\s+pg:reset\b/i, 'reset a Heroku database', NOTE.dropDb],
]

const MIGRATION_DIR_WORD =
  /(^|[\s'"=\\/*(,])(migrations?|db[\\/]migrate|db[\\/]changelog|alembic[\\/]versions|drizzle(?=[\\/]))(?=$|[\s'"\\/*),])/i
// The folder has to be a whole path segment: cd tools/migration-guard is not cd migrations.
const CD_INTO_MIGRATIONS =
  /^\s*(cd|pushd|Set-Location|Push-Location|sl)\s+["']?(?:\S{0,300}[\\/])?(migrations?|db[\\/]migrate|db[\\/]changelog|alembic[\\/]versions|drizzle)(?=$|[\\/\s'"])/i
const CD = /^\s*(cd|pushd|popd|Set-Location|Push-Location|Pop-Location|sl)\b/i
const REDIRECT = /(?:>{1,2}|\btee\s+(?:-a\s+)?)\s*(\S+)/g

/** A redirect (`>`, `>>`, `tee`) whose target is a migration file. A README or a test next to it doesn't count. */
function writesMigration(text: string, extraPath?: RegExp): boolean {
  for (const m of capped(text).matchAll(REDIRECT)) {
    if (isMigrationPath((m[1] ?? '').replace(/["']/g, ''), extraPath)) return true
  }
  return false
}

// A short command name only counts where a command starts: `grep -rni` is not PowerShell's `rni`.
const AT_COMMAND = String.raw`(?:^\s*|[|({\x60]\s*|\$\(\s*|\bxargs(?:\s+-\S+)*\s+|-exec(?:dir)?\s+|\b(?:sudo|time|nohup|command|env)\s+(?:-\S+\s+)*|\b\w+=\S*\s+)`
const IN_PLACE = /\b(sed|perl)\b[^|;&\n]{0,300}?\s(-\w*i|--in-place)/i
// Unix, Windows (cmd, PowerShell) ways of changing, moving or deleting files.
const FILE_VERB = new RegExp(
  [
    IN_PLACE.source,
    `${AT_COMMAND}(rm|rmdir|mv|truncate|unlink|shred|del|erase|rd|ren|rename|move|ri|ni|mi|rni|touch|unzip)(?=\\s|$)`,
    `${AT_COMMAND}(tar\\s+-?\\w*x|tar\\b[^|;&\\n]{0,200}--extract|dd\\b[^|;&\\n]{0,300}?\\bof=|(curl|wget)\\b[^|;&\\n]{0,300}?\\s-[oO]\\b)`,
    String.raw`\bgit\s+(checkout(?!\s+-[bBt]\b)|restore(?![^|;&\n]{0,200}--staged\b)|rm|mv|clean|apply|stash)\b`,
    String.raw`\b(Remove|Move|Rename|New|Clear)-Item\b|\b(Set|Add|Clear)-Content\b|\bOut-File\b`,
    String.raw`\s-delete\b`,
  ].join('|'),
  'i',
)
// Copies only change migrations when they land in a migrations folder: cp migrations/x.sql /tmp/ is a read.
const COPY_VERB = new RegExp(`${AT_COMMAND}(cp|copy|cpi|rsync|install|ln)(?=\\s|$)|\\bCopy-Item\\b`, 'i')
const DELETES = new RegExp(
  `${AT_COMMAND}(rm|rmdir|del|erase|rd|ri|unlink|shred|truncate)(?=\\s|$)|\\bgit\\s+(rm|clean)\\b|\\b(Remove-Item|Clear-Content)\\b|\\s-delete\\b`,
  'i',
)
// Steps whose quoted text is code that runs (bash -c "...", ssh host "..."), not text to ignore.
const RUNS_QUOTED = /\b(bash|sh|zsh|dash|ksh|fish|pwsh|powershell|cmd(\.exe)?|ssh|eval|su|docker\s+(exec|run)|podman\s+(exec|run)|kubectl\s+exec)\b/i
// One-liners: python -c "...", node -e "...", ruby -e, php -r, deno eval
const ONE_LINER = /^\s*(?:\w+=\S*\s+)*(?:sudo\s+)?(python[\d.]*|node|deno|bun|ruby|perl|php|tsx)\b[^|;&\n]{0,100}?\s(-c|-e|-r|-p|--eval|eval)\s/i

/** The step with quoted text blanked out: `grep "TRUNCATE" migrations/` searches, it doesn't truncate. */
function unquoted(text: string): string {
  return text.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '""')
}

/** The last word of a step, without quotes: where cp, rsync and friends put things. */
function destination(text: string): string {
  return (text.trim().split(/\s+/).pop() ?? '').replace(/^["']|["']$/g, '')
}

/** A shell change to migration files. Deleting is high risk; writing is judged by what's written. */
function shellChange(step: Step, written: readonly string[]): CommandHit {
  const findings = dedupe([
    ...findDestructive(step.text, { keepComments: true }),
    ...written.flatMap((body) => findDestructive(body, { skipDown: true })),
  ])
  const deletes = DELETES.test(unquoted(step.text))
  const risky = deletes || riskOf(findings) === 'high'
  // `cat > migrations/x.sql <<'EOF'` reads better without the heredoc marker.
  const part = step.text.trim().replace(/\s*<<-?\s*(['"]?)[\w.-]+\1\s*$/, '')
  return { reason: 'change migration files from the shell', risky, note: deletes ? NOTE.shellDeletes : NOTE.shellWrites, findings, part }
}

// ------------------------------------------------------------- scripts

// What scripts call to write, move or delete files, and the path arguments they take:
// open(p, 'w'), fs.writeFileSync(p, ...), os.remove(p), shutil.move(a, b), Path(p).write_text(...), p.unlink()
const WRITE_CALL =
  /\bopen\(\s*([^,)]{1,300}?)\s*,\s*[rf]?['"][wax]|\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|unlink(?:Sync)?|rmSync|rmdirSync|renameSync|copyFileSync|createWriteStream|fs\.(?:rm|unlink|rename|writeFile|appendFile|copyFile)|os\.(?:remove|unlink|rename|replace|rmdir)|shutil\.(?:rmtree|move|copy\w*)|FileUtils\.(?:rm\w*|mv|cp)|File\.(?:write|delete|rename))\s*\(([^)]{0,300})\)|\bPath\(\s*([^)]{1,300}?)\s*\)\s*\.(?:write_text|write_bytes|unlink|rename|replace|rmdir)\b|\b(\w+)\.(?:write_text|write_bytes|unlink)\s*\(/g
const SCRIPT_DELETE = /\b(unlink(Sync)?|rmSync|rmdirSync|os\.(remove|unlink|rmdir)|shutil\.rmtree|FileUtils\.rm\w*|File\.delete|fs\.(rm|unlink))\b/
const SCRIPT_SPAWNS = /\b(subprocess\.\w+|os\.system|os\.popen|execSync|execFileSync|spawnSync|exec|spawn|system|popen)\s*\(/g
const SCRIPT_QUERIES = /\.(execute|executescript|query|exec|raw)\s*\(/g
const LITERAL = /'''([\s\S]{0,20000}?)'''|"""([\s\S]{0,20000}?)"""|'((?:[^'\\\n]|\\.){0,5000})'|"((?:[^"\\\n]|\\.){0,5000})"|`([^`]{0,20000})`/g
// A migrations folder, or a folder inside one: 'migrations', 'src/database/migrations/index/'
const MIGRATION_DIR_ONLY = /(^|[\\/])(migrations?|db[\\/]migrate|db[\\/]changelog|alembic[\\/]versions|drizzle)([\\/][^.]*)?$/i

/** The code a one-liner runs: the quoted argument after -c or -e. */
function oneLinerCode(text: string): string {
  return /\s(?:-c|-e|-r|-p|--eval|eval)\s+(['"])((?:(?!\1)[^\\]|\\[\s\S]){0,20000})\1/.exec(text)?.[2] ?? text
}

function stringLiterals(code: string): string[] {
  const out: string[] = []
  for (const m of capped(code).matchAll(LITERAL)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] ?? '')
    if (out.length >= 2000) break
  }
  return out
}

/** Where the script's longer strings sit, so a call written inside a string (text being inserted) doesn't count. */
function stringRanges(code: string): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = []
  for (const m of code.matchAll(LITERAL)) {
    if (m[0].length > 6) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
    if (out.length >= 2000) break
  }
  return out
}

function insideAny(ranges: ReadonlyArray<readonly [number, number]>, index: number): boolean {
  return ranges.some(([start, end]) => index > start && index < end)
}

/**
 * What a path argument stands for: a string ('x.ts', f'...{n}.ts'), a variable
 * assigned a string somewhere in the script (p = 'x.ts'), the first argument
 * at every call of a helper whose parameter it is (def edit(p, ...) called as
 * edit('x.ts', ...)), or the strings in an expression
 * (os.path.join(ROOT, 'migrations', name)). `sure` is false when the script
 * builds the path in a way we can't follow.
 */
function pathValues(expr: string, code: string): { values: string[]; sure: boolean } {
  const e = expr.trim()
  const literal = /^[rfb]?(['"`])([\s\S]*)\1$/.exec(e)
  if (literal) return { values: [literal[2] ?? ''], sure: true }
  if (/^\w+$/.test(e)) {
    const assigned = new RegExp(String.raw`(?:^|[\s;(,])(?:const\s+|let\s+|var\s+)?${e}\s*=\s*(?:Path\(\s*)?[rf]?(['"\x60])([^'"\x60\n]{0,500})\1`, 'm').exec(code)
    if (assigned) return { values: [assigned[2] ?? ''], sure: true }
    // A helper's first parameter: look at what each call passes.
    const helper = new RegExp(String.raw`\b(?:def|function)\s+(\w+)\s*\(\s*${e}\b`).exec(code)?.[1]
    if (helper) {
      const passed = [...code.matchAll(new RegExp(String.raw`(?<!def |function )\b${helper}\(\s*([^,)]{1,300})`, 'g'))].slice(0, 50)
      const each = passed.map((m) => pathValues(m[1] ?? '', code.replace(new RegExp(String.raw`\b(?:def|function)\s+${helper}\b`, 'g'), '')))
      return { values: each.flatMap((p) => p.values), sure: passed.length > 0 && each.every((p) => p.sure) }
    }
    return { values: [], sure: false }
  }
  return { values: stringLiterals(e), sure: false }
}

/**
 * A script (python -c, node -e, a heredoc fed to python) that writes or
 * deletes a migration file, runs migrations, or runs destructive SQL. A write
 * counts when its target is a migration path; when the target can't be
 * followed, when any string in the script is one. So a script that edits a
 * doc which merely mentions migrations/ stays quiet.
 */
function scriptChange(code: string, extraPath: RegExp | undefined, insideMigrations: boolean): CommandHit | undefined {
  code = capped(code)
  const literals = stringLiterals(code)
  const ranges = stringRanges(code)
  // After a cd into a migrations folder, a bare file name ('001.sql') is a migration too.
  const isTarget = (l: string) =>
    !/[*?]/.test(l) && (isMigrationPath(l, extraPath) || MIGRATION_DIR_ONLY.test(l) || (insideMigrations && CODE_FILE.test(l) && !/[\\/\s]/.test(l)))

  let writes = false
  let hit: string | undefined // the migration it writes, named in the question
  let unsure = false
  let looked = 0
  const resolved = new Map<string, { values: string[]; sure: boolean }>()
  for (const m of code.matchAll(WRITE_CALL)) {
    if (hit !== undefined) break
    if (++looked > 50) {
      unsure = true // real scripts write a handful of files; past that, fall back to any migration path in it
      break
    }
    if (insideAny(ranges, m.index ?? 0)) continue
    writes = true
    const args = m[1] ?? m[3] ?? m[4] ?? (m[2] ?? '').split(',').slice(0, 2).join('\u0000')
    for (const arg of args.split('\u0000')) {
      const key = arg.trim()
      const found = resolved.get(key) ?? pathValues(key, code)
      resolved.set(key, found)
      hit ??= found.values.find(isTarget)
      if (!found.sure) unsure = true
    }
  }
  if (writes && unsure) hit ??= literals.find(isTarget)
  if (writes && hit !== undefined) {
    const findings = findDestructive(literals.join('\n'), { skipDown: true })
    const deletes = SCRIPT_DELETE.test(code)
    const risky = deletes || riskOf(findings) === 'high'
    return { reason: 'change a migration file from a script', risky, note: deletes ? NOTE.shellDeletes : NOTE.scriptWrites, findings, part: shortPath(hit) }
  }

  const calls = (re: RegExp) => {
    let looked = 0
    for (const m of code.matchAll(re)) {
      if (!insideAny(ranges, m.index ?? 0)) return true
      if (++looked > 50) break
    }
    return false
  }
  const words = literals.join(' ')
  if (calls(SCRIPT_SPAWNS)) {
    for (const [re, what] of RUNNERS) {
      const ran = re.exec(words)?.[0]
      if (ran) return { reason: `run ${what} from a script`, ...riskOfWords(words), findings: [], part: ran }
    }
  }
  if (calls(SCRIPT_QUERIES)) {
    const findings = findDestructive(words, { keepComments: true })
    const first = findings[0]
    if (first) return { reason: 'run destructive SQL from a script', risky: riskOf(findings) === 'high', note: NOTE.sqlDirect, findings, part: first.snippet }
  }
  return undefined
}

function dedupe(findings: Finding[]): Finding[] {
  return findings.filter((f, i) => findings.findIndex((g) => g.label === f.label) === i)
}

/** Why a shell command touches migrations or the database, or undefined when it doesn't. */
export function classifyCommand(
  command: string,
  opts: { extra?: RegExp; extraPath?: RegExp; powershell?: boolean } = {},
): CommandHit | undefined {
  const powershell = opts.powershell === true
  if (command.length > MAX_SCAN) return { reason: 'run a command too long to check', risky: true, note: NOTE.tooLong, findings: [], part: command.slice(-100) }
  // A line continuation (\ in sh, ` in PowerShell) joins one command.
  command = command.replace(powershell ? /`\r?\n/g : /\\\r?\n/g, ' ')
  const heredocs = readHeredocs(command, opts.extraPath)
  const steps = splitSteps(heredocs.text, false, powershell)
  const live = steps.filter((s) => !onlyMentions(s, powershell))
  const liveText = live.map((s) => s.text).join('\n')
  const findings = findDestructive(liveText, { keepComments: true })

  if (opts.extra?.test(command)) return { reason: 'run a command from your extraCommandPattern', ...riskOfExtra(command), findings, part: command }

  for (const step of live) {
    for (const [re, reason, note] of DATA_WIPES) {
      if (re.test(step.text)) return { reason, risky: true, note, findings, part: step.text.trim() }
    }
    if (/\bpg_restore\b[^|;&\n]{0,300}\s(-d|--dbname)\b|\bmongorestore\b/i.test(step.text)) {
      const clean = /\s(-c|--clean|--drop)\b/i.test(step.text)
      return { reason: 'restore a dump into a database', risky: clean, note: clean ? NOTE.restoreClean : NOTE.restore, findings, part: step.text.trim() }
    }
  }

  const client = live.find((s) => DB_CLIENT.test(s.text))
  if (client) {
    const part = client.text.trim()
    if (findings.length > 0) return { reason: 'run destructive SQL directly', risky: riskOf(findings) === 'high', note: NOTE.sqlDirect, findings, part }
    const at = client.text.search(DB_CLIENT)
    if (SQL_FILE_INPUT.test(client.text.slice(at)) || SQL_PIPED_IN.test(client.text.slice(0, at))) {
      return { reason: 'run a SQL file against a database', risky: true, note: NOTE.sqlFile, findings, part }
    }
  }

  // Each step on its own, so `rm -rf /tmp/x && echo "see migrations/"` doesn't
  // count. Pipes stay inside a step (`find migrations | xargs rm`), and a
  // `cd` into a migrations folder carries over until the next `cd`.
  let insideMigrations = false
  let wentInside = false
  for (const step of steps) {
    if (CD_INTO_MIGRATIONS.test(step.text)) insideMigrations = wentInside = true
    else if (CD.test(step.text)) insideMigrations = false
    if (writesMigration(step.text, opts.extraPath)) return shellChange(step, heredocs.written)
    if (onlyMentions(step, powershell)) continue
    if (ONE_LINER.test(step.text) && !IN_PLACE.test(step.text)) {
      const hit = scriptChange(oneLinerCode(step.text), opts.extraPath, insideMigrations)
      if (hit) return hit
      continue
    }
    // Quoted text is a search pattern or a message, unless the step hands it to a shell.
    const verbs = RUNS_QUOTED.test(step.text) ? step.text : unquoted(step.text)
    const patch = APPLIES_PATCH.test(verbs)
    if ((patch || FILE_VERB.test(verbs)) && (insideMigrations || MIGRATION_DIR_WORD.test(patch ? liveText : step.text))) {
      return shellChange(step, [])
    }
    if (COPY_VERB.test(verbs)) {
      const to = destination(step.text)
      if (MIGRATION_DIR_WORD.test(to) || (insideMigrations && !/^([\\/~]|[a-z]:)/i.test(to))) return shellChange(step, [])
    }
  }
  for (const script of heredocs.scripts) {
    const hit = scriptChange(script, opts.extraPath, wentInside)
    if (hit) return hit
  }

  for (const step of live) {
    if (ONE_LINER.test(step.text)) continue // judged as a script above
    for (const part of splitSteps(step.text, true, powershell)) {
      if (READ_ONLY.test(part.text) || (ONLY_MENTIONS.test(part.text) && !part.substitutes)) continue
      // Quotes the shell removes don't hide a name: npm run 'db:migrate', mig""ration:run
      const plain = part.text.replace(/["']/g, '')
      for (const [re, what] of RUNNERS) {
        if (re.test(part.text) || re.test(plain)) return { reason: `run ${what}`, ...riskOfWords(part.text), findings, part: part.text.trim() }
      }
    }
  }
  return undefined
}

function riskOfExtra(command: string): { risky: boolean; note: string } {
  const { risky } = riskOfWords(command)
  return { risky, note: NOTE.extra }
}

// ------------------------------------------------------------- MCP tools

export type McpHit = CommandHit & { kind: 'file' | 'command'; key: string; target: string }

const MCP_READS = /^(list|get|show|describe|read|search|find|fetch|view|check|explain)|[-_](status|list|history)$/i
const MCP_RUNS_SQL = /sql|query|exec|statement|transaction|(^|[-_])run([-_]|$)/i
const MCP_WRITES = /write|edit|create|update|move|rename|delete|remove|patch|put|append|replace|copy|upload|push|commit/i
const PATH_KEY = /path|file|source|destination|target|^(from|to|src|dest|uri)$/i

/** Every string in a tool's arguments with the key it sits under, a few levels deep. */
function stringLeaves(value: unknown, key = '', depth = 0, out: { key: string; value: string }[] = []) {
  if (out.length >= 200 || depth > 4) return out
  if (typeof value === 'string') out.push({ key, value })
  else if (Array.isArray(value)) for (const item of value) stringLeaves(item, key, depth + 1, out)
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) stringLeaves(v, k, depth + 1, out)
  }
  return out
}

/**
 * An MCP tool that migrates (Supabase apply_migration, Prisma migrate-reset),
 * runs destructive SQL (execute_sql, run_sql), or writes a migration file
 * (a filesystem or GitHub server).
 */
export function classifyMcpCall(tool: string, args: Readonly<Record<string, unknown>>, extraPath?: RegExp): McpHit | undefined {
  const [, server = '', ...rest] = tool.split('__')
  const name = rest.join('__')
  const label = `${name} (${server.replace(/^claude_ai_/i, '')})`
  const leaves = stringLeaves(args)
  const text = capped(leaves.map((l) => l.value).join('\n'))
  const findings = findDestructive(text, { keepComments: true })
  const key = `${tool}\n${text}`

  if (/migrat/i.test(name) && !MCP_READS.test(name)) {
    const words = riskOfWords(name)
    const note = words.note === NOTE.applies ? NOTE.mcp : words.note
    return { kind: 'command', key, target: label, reason: 'change the database with an MCP tool', risky: words.risky, note, findings, part: label }
  }
  if (MCP_WRITES.test(name)) {
    const path = leaves.find((l) => PATH_KEY.test(l.key) && isMigrationPath(l.value, extraPath))
    if (path) {
      const content = leaves.filter((l) => !PATH_KEY.test(l.key)).map((l) => l.value).join('\n')
      return {
        kind: 'file',
        key: approvalKey(path.value),
        target: shortPath(path.value),
        reason: `change a migration file with ${label}`,
        risky: false,
        note: '',
        findings: isUndoFile(path.value) ? [] : findDestructive(content, { skipDown: true, hashComments: usesHashComments(path.value) }),
        part: label,
      }
    }
  }
  if (findings.length > 0 && MCP_RUNS_SQL.test(name)) {
    return { kind: 'command', key, target: label, reason: 'run destructive SQL with an MCP tool', risky: riskOf(findings) === 'high', note: NOTE.sqlDirect, findings, part: label }
  }
  return undefined
}

// ------------------------------------------------------------- helpers

/** A user-supplied pattern from the plugin's settings; an invalid one is ignored. */
export function safeRegex(source: unknown): RegExp | undefined {
  if (typeof source !== 'string' || source.trim() === '') return undefined
  try {
    return new RegExp(source, 'i')
  } catch {
    return undefined
  }
}

/** The last three path segments, so the question stays readable. */
export function shortPath(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `.../${parts.slice(-3).join('/')}` : path
}

/** Windows paths are case-insensitive, so "don't ask again" shouldn't care about case there. */
export function approvalKey(path: string): string {
  return /^[a-z]:[\\/]|\\/i.test(path) ? path.toLowerCase() : path
}
