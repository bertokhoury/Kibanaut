/**
 * Command metadata used by the completer, the linter, and the column tracker.
 * ES|QL's grammar lists the command names; this file adds the semantics.
 */
export type ArgKind =
  | 'sources' // FROM logs-*, metrics-*
  | 'expression' // WHERE <bool>, LIMIT handled separately
  | 'assignments' // EVAL x = ..., STATS c = COUNT()
  | 'columns' // KEEP a, b / DROP / MV_EXPAND
  | 'renames' // RENAME a AS b
  | 'orders' // SORT a DESC
  | 'number' // LIMIT 10 / SAMPLE 0.1
  | 'policy' // ENRICH policy
  | 'pattern' // DISSECT/GROK col "pattern"
  | 'lookup' // LOOKUP JOIN index ON key
  | 'branches' // FORK (..) (..)
  | 'raw'; // anything else

/** How a command changes the set of columns flowing to the next command. */
export type ColumnEffect =
  | 'none' // WHERE, SORT, LIMIT
  | 'add' // EVAL adds assigned columns
  | 'add-unknown' // GROK/DISSECT/ENRICH/JOIN add columns we cannot name statically
  | 'replace' // STATS replaces everything with aggregates + groups
  | 'select' // KEEP
  | 'drop' // DROP
  | 'rename' // RENAME
  | 'unknown'; // FORK and friends: stop tracking

export interface CommandDef {
  name: string;
  kind: 'source' | 'processing' | 'header';
  summary: string;
  /** Text inserted by completion; `$0` marks the cursor. */
  snippet: string;
  argKind: ArgKind;
  /** Keywords that are valid inside this command (completion offers them). */
  keywords: string[];
  columnEffect: ColumnEffect;
  example: string;
}

const C = (
  name: string,
  kind: CommandDef['kind'],
  summary: string,
  argKind: ArgKind,
  columnEffect: ColumnEffect,
  example: string,
  keywords: string[] = [],
  snippet = `${name} $0`,
): CommandDef => ({ name, kind, summary, snippet, argKind, keywords, columnEffect, example });

export const COMMANDS: CommandDef[] = [
  // Source commands
  C('FROM', 'source', 'Read rows from indices, aliases, or data streams', 'sources', 'none', 'FROM logs-* METADATA _index', ['METADATA']),
  C('ROW', 'source', 'Produce a single row from literal values', 'assignments', 'none', 'ROW a = 1, b = "two"'),
  C('SHOW', 'source', 'Show deployment information', 'raw', 'none', 'SHOW INFO', ['INFO']),
  C('TS', 'source', 'Read time-series data streams for metrics queries', 'sources', 'none', 'TS metrics-* | STATS max(rate(bytes)) BY host'),
  C('EXPLAIN', 'source', 'Explain the physical plan of a query', 'raw', 'unknown', 'EXPLAIN (FROM logs | LIMIT 10)'),
  C('PROMQL', 'source', 'Run a PromQL expression against time-series data', 'raw', 'unknown', 'PROMQL step=1m "rate(http_requests_total[5m])"'),
  // Header commands
  C('SET', 'header', 'Set a query-level setting', 'raw', 'none', 'SET query_timeout = "30s"; FROM logs'),
  // Processing commands
  C('WHERE', 'processing', 'Keep rows where the condition is true', 'expression', 'none', 'WHERE status >= 500 AND host.name LIKE "web*"', ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'RLIKE', 'IS NULL', 'IS NOT NULL', 'TRUE', 'FALSE', 'NULL']),
  C('EVAL', 'processing', 'Add or replace columns with computed values', 'assignments', 'add', 'EVAL kb = bytes / 1024'),
  C('STATS', 'processing', 'Aggregate rows, optionally grouped with BY', 'assignments', 'replace', 'STATS c = COUNT(*), avg = AVG(bytes) BY host.name', ['BY', 'WHERE']),
  C('INLINE STATS', 'processing', 'Aggregate without dropping the original columns', 'assignments', 'add', 'INLINE STATS total = SUM(bytes) BY host.name', ['BY']),
  C('INLINESTATS', 'processing', 'Aggregate without dropping the original columns', 'assignments', 'add', 'INLINESTATS total = SUM(bytes) BY host.name', ['BY']),
  C('KEEP', 'processing', 'Keep only the listed columns, in this order', 'columns', 'select', 'KEEP @timestamp, host.name, message'),
  C('DROP', 'processing', 'Remove columns', 'columns', 'drop', 'DROP _score, event.original'),
  C('RENAME', 'processing', 'Rename columns', 'renames', 'rename', 'RENAME host.name AS host', ['AS']),
  C('SORT', 'processing', 'Sort rows by one or more columns', 'orders', 'none', 'SORT @timestamp DESC NULLS LAST', ['ASC', 'DESC', 'NULLS FIRST', 'NULLS LAST']),
  C('LIMIT', 'processing', 'Return at most N rows', 'number', 'none', 'LIMIT 100'),
  C('MV_EXPAND', 'processing', 'Expand a multi-valued column into one row per value', 'columns', 'none', 'MV_EXPAND tags'),
  C('DISSECT', 'processing', 'Extract columns using a dissect pattern', 'pattern', 'add-unknown', 'DISSECT message "%{client} %{method} %{path}"', ['APPEND_SEPARATOR']),
  C('GROK', 'processing', 'Extract columns using a grok pattern', 'pattern', 'add-unknown', 'GROK message "%{IP:client} %{WORD:method}"'),
  C('ENRICH', 'processing', 'Add columns from an enrich policy', 'policy', 'add-unknown', 'ENRICH geo_policy ON ip WITH country', ['ON', 'WITH']),
  C('LOOKUP JOIN', 'processing', 'Join columns from a lookup-mode index', 'lookup', 'add-unknown', 'LOOKUP JOIN hosts_lookup ON host.name', ['ON']),
  C('LEFT JOIN', 'processing', 'Left join against a lookup-mode index', 'lookup', 'add-unknown', 'LEFT JOIN hosts_lookup ON host.name', ['ON']),
  C('RIGHT JOIN', 'processing', 'Right join against a lookup-mode index', 'lookup', 'add-unknown', 'RIGHT JOIN hosts_lookup ON host.name', ['ON']),
  C('FORK', 'processing', 'Run several branches and union the results', 'branches', 'unknown', 'FORK (WHERE a > 1) (WHERE b > 1)', [], 'FORK ($0)'),
  C('FUSE', 'processing', 'Merge FORK branches with rank fusion', 'raw', 'unknown', 'FUSE', ['SCORE', 'KEY', 'GROUP', 'WITH']),
  C('SAMPLE', 'processing', 'Keep a random sample of rows', 'number', 'none', 'SAMPLE 0.1'),
  C('CHANGE_POINT', 'processing', 'Detect change points in a series', 'raw', 'add-unknown', 'CHANGE_POINT value ON @timestamp AS type, pvalue', ['ON', 'AS']),
  C('COMPLETION', 'processing', 'Generate text with an inference endpoint', 'raw', 'add', 'COMPLETION answer = prompt WITH { "inference_id": "my-endpoint" }', ['WITH']),
  C('RERANK', 'processing', 'Rerank rows with an inference endpoint', 'raw', 'add', 'RERANK "query" ON title WITH { "inference_id": "my-reranker" }', ['ON', 'WITH']),
  C('DEDUP', 'processing', 'Remove duplicate rows by column', 'columns', 'none', 'DEDUP host.name'),
  C('FILLNULL', 'processing', 'Replace null values', 'raw', 'none', 'FILLNULL'),
  C('MMR', 'processing', 'Maximal marginal relevance re-ranking', 'raw', 'none', 'MMR'),
];

const byName = new Map(COMMANDS.map((c) => [c.name.toLowerCase(), c]));

/** Everyday commands first in completion lists; the rest follow alphabetically. */
const POPULAR = ['WHERE', 'STATS', 'EVAL', 'KEEP', 'SORT', 'LIMIT', 'DROP', 'RENAME', 'DISSECT', 'GROK', 'ENRICH', 'LOOKUP JOIN', 'MV_EXPAND', 'FROM', 'ROW', 'TS', 'SHOW'];

export function commandRank(name: string): number {
  const i = POPULAR.indexOf(name.toUpperCase());
  return i === -1 ? POPULAR.length : i;
}

/** Resolve a command by its AST name (`join` with commandType, `inline stats`, ...). */
export function getCommand(name: string, commandType?: string): CommandDef | undefined {
  const lower = name.toLowerCase();
  if (lower === 'join') return byName.get(`${commandType ?? 'lookup'} join`);
  return byName.get(lower) ?? byName.get(lower.replace(/_/g, ' '));
}

export const SOURCE_COMMANDS = COMMANDS.filter((c) => c.kind === 'source');
export const PROCESSING_COMMANDS = COMMANDS.filter((c) => c.kind === 'processing');
