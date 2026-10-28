export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  /** Rule id, e.g. E001 (syntax) or W101 (no-limit). */
  code: string;
  /** Human readable rule name, e.g. `no-implicit-limit`. */
  rule: string;
  severity: Severity;
  message: string;
  /** Zero-based character offsets into the query text, end exclusive. */
  start: number;
  end: number;
  /** One-based line/column derived from `start`. */
  line: number;
  column: number;
  /** When set, `fmt --fix` or the TUI can apply this rule's auto-fix. */
  fixable?: boolean;
}

export type SuggestionKind =
  | 'command'
  | 'keyword'
  | 'function'
  | 'aggregation'
  | 'column'
  | 'source'
  | 'policy'
  | 'lookup'
  | 'value'
  | 'operator';

export interface Suggestion {
  label: string;
  insertText: string;
  kind: SuggestionKind;
  detail?: string;
  documentation?: string;
  /** Lower sorts first. */
  rank: number;
  /** Move the cursor this many characters back after inserting (e.g. -1 to land inside `()`). */
  cursorDelta?: number;
}

export interface Field {
  name: string;
  type: string;
}

export interface SchemaSource {
  /** Index names, aliases, and data streams the cluster exposes. */
  listSources(): Promise<string[]>;
  /** Columns produced by `query | LIMIT 0`. */
  columnsFor(queryPrefix: string): Promise<Field[]>;
  listPolicies(): Promise<string[]>;
  listLookupIndices(): Promise<string[]>;
}

export interface LineIndex {
  starts: number[];
  text: string;
}

export function indexLines(text: string): LineIndex {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return { starts, text };
}

/** Converts a zero-based offset to one-based {line, column}. */
export function offsetToPosition(index: LineIndex, offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - index.starts[lo] + 1 };
}

/** Converts one-based {line, column} to a zero-based offset. */
export function positionToOffset(index: LineIndex, line: number, column: number): number {
  const start = index.starts[Math.max(0, Math.min(line - 1, index.starts.length - 1))];
  return start + Math.max(0, column - 1);
}
