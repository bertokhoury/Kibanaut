import { COMMANDS, commandRank, getCommand, PROCESSING_COMMANDS, SOURCE_COMMANDS, type CommandDef } from '../definitions/commands.js';
import { formatSignature, listFunctions, type FunctionDef } from '../definitions/index.js';
import { commandAt, parseQuery } from './ast.js';
import { computeColumnFlow } from './columns.js';
import { tokenize, wordBefore, type Token } from './tokenize.js';
import type { Field, Suggestion } from './types.js';

export interface CompletionSchema {
  /** Columns available to the command under the cursor (from `prefix | LIMIT 0`). */
  columns?: Field[];
  /** Fields of the FROM/TS sources, used to derive columns statically when `columns` is absent. */
  baseFields?: Field[];
  sources?: string[];
  policies?: string[];
  lookupIndices?: string[];
}

export interface CompletionInput {
  text: string;
  offset: number;
  schema?: CompletionSchema;
  limit?: number;
}

export interface CompletionResult {
  suggestions: Suggestion[];
  /** Replace text[replaceStart, replaceEnd) with the chosen insertText. */
  replaceStart: number;
  replaceEnd: number;
  /** Human readable description of what the engine thinks the cursor is at. */
  context: string;
}

const METADATA_FIELDS = ['_index', '_id', '_version', '_score', '_source', '_ignored', '_index_mode'];
const COMPARISONS = ['==', '!=', '>', '>=', '<', '<='];
const BOOLEAN_KEYWORDS = ['AND', 'OR', 'NOT', 'IN', 'LIKE', 'RLIKE', 'IS NULL', 'IS NOT NULL'];

/** Offset of the last `|` before `offset` that is not inside a string or comment. */
export function lastPipeBefore(text: string, offset: number): number {
  let last = -1;
  for (const t of tokenize(text.slice(0, offset))) if (t.kind === 'pipe') last = t.start;
  return last;
}

function commandSuggestion(def: CommandDef): Suggestion {
  return {
    label: def.name,
    insertText: def.snippet.replace('$0', ''),
    kind: 'command',
    detail: def.summary,
    documentation: def.example,
    rank: commandRank(def.name),
  };
}

function functionSuggestion(def: FunctionDef, rank: number): Suggestion {
  const sig = def.signatures[0];
  const hasParams = sig ? sig.params.length > 0 : true;
  return {
    label: def.name,
    insertText: `${def.name}(${hasParams ? '' : ''})`,
    kind: def.type === 'agg' || def.type === 'time_series_agg' ? 'aggregation' : 'function',
    detail: formatSignature(def),
    documentation: def.description,
    rank,
    cursorDelta: hasParams ? -1 : 0,
  };
}

function keyword(label: string, rank = 3, detail?: string): Suggestion {
  return { label, insertText: `${label} `, kind: 'keyword', rank, detail };
}

function columnSuggestions(columns: Field[] | undefined, rank = 1): Suggestion[] {
  return (columns ?? []).map((f) => ({
    label: f.name,
    insertText: /[^A-Za-z0-9_@.*]/.test(f.name) ? `\`${f.name}\`` : f.name,
    kind: 'column',
    detail: f.type,
    rank,
  }));
}

function significant(tokens: Token[]): Token[] {
  return tokens.filter((t) => t.kind !== 'whitespace' && t.kind !== 'comment');
}

/** True when the token before the cursor completes an operand (so an operator or keyword comes next). */
function afterOperand(prev: Token | undefined, text: string, offset: number): boolean {
  if (!prev) return false;
  const gap = text.slice(prev.end, offset);
  if (!/\s/.test(gap)) return false;
  if (prev.kind === 'identifier' || prev.kind === 'number' || prev.kind === 'string' || prev.kind === 'param') return true;
  if (prev.kind === 'punct' && prev.text === ')') return true;
  if (prev.kind === 'keyword' && /^(TRUE|FALSE|NULL)$/i.test(prev.text)) return true;
  return false;
}

export function complete(input: CompletionInput): CompletionResult {
  const { text, offset } = input;
  const schema = input.schema ?? {};
  const { word, start } = wordBefore(text, offset);
  const prefix = word.toLowerCase();
  const pipeIdx = lastPipeBefore(text, offset);
  const segment = text.slice(pipeIdx + 1, offset);
  const segTokens = significant(tokenize(segment)).map((t) => ({ ...t, start: t.start + pipeIdx + 1, end: t.end + pipeIdx + 1 }));
  const tokensBeforeWord = segTokens.filter((t) => t.end <= start);
  const prev = tokensBeforeWord[tokensBeforeWord.length - 1];
  const out: Suggestion[] = [];
  let context = 'unknown';

  const parsed = parseQuery(text);
  const flow = computeColumnFlow(parsed.commands, schema.baseFields);
  const located = commandAt(parsed.commands, Math.max(0, pipeIdx + 1));
  const env = located ? flow.before[located.index] : undefined;
  const columns: Field[] = schema.columns ?? (env ? [...env.columns].map(([name, type]) => ({ name, type })) : []);

  const commandWords = tokensBeforeWord.filter((t) => t.kind === 'command').map((t) => t.text.toUpperCase());
  const atCommandName = tokensBeforeWord.length === 0 || (tokensBeforeWord.every((t) => t.kind === 'command') && /^(INLINE|LOOKUP|LEFT|RIGHT)$/.test(commandWords[commandWords.length - 1] ?? ''));

  if (atCommandName) {
    const isFirst = pipeIdx === -1 && text.slice(0, pipeIdx + 1).trim() === '';
    context = isFirst ? 'source command' : 'processing command';
    const pool = isFirst ? SOURCE_COMMANDS : PROCESSING_COMMANDS;
    const partial = commandWords.join(' ');
    for (const def of pool) {
      if (partial && !def.name.startsWith(partial + ' ')) continue;
      const label = partial ? def.name.slice(partial.length + 1) : def.name;
      out.push({ ...commandSuggestion(def), label, insertText: `${label} ` });
    }
  } else {
    const cmdName = commandWords.join(' ');
    const def = getCommand(cmdName.toLowerCase()) ?? COMMANDS.find((c) => c.name === cmdName);
    const isOperandDone = afterOperand(prev, text, start);
    const depth = tokensBeforeWord.filter((t) => t.text === '(').length - tokensBeforeWord.filter((t) => t.text === ')').length;
    const lastKeyword = [...tokensBeforeWord].reverse().find((t) => t.kind === 'keyword')?.text.toUpperCase();

    switch (def?.argKind) {
      case 'sources': {
        if (lastKeyword === 'METADATA') {
          context = 'metadata field';
          out.push(...METADATA_FIELDS.map((f) => ({ label: f, insertText: f, kind: 'column' as const, rank: 1, detail: 'metadata' })));
        } else {
          context = 'source';
          out.push(...(schema.sources ?? []).map((s) => ({ label: s, insertText: s, kind: 'source' as const, rank: 1 })));
          if (prev && prev.kind === 'identifier' && isOperandDone && def.name !== 'TS') out.push(keyword('METADATA', 2, 'Expose _index, _id, _score, ...'));
        }
        break;
      }
      case 'number': {
        context = 'number';
        const values = def.name === 'SAMPLE' ? ['0.1', '0.01', '0.5'] : ['10', '100', '1000', '10000'];
        out.push(...values.map((v, i) => ({ label: v, insertText: v, kind: 'value' as const, rank: i })));
        break;
      }
      case 'columns': {
        context = 'column';
        const listed = new Set(tokensBeforeWord.filter((t) => t.kind === 'identifier').map((t) => t.text));
        out.push(...columnSuggestions(columns.filter((c) => !listed.has(c.name))));
        break;
      }
      case 'renames': {
        if (isOperandDone && lastKeyword !== 'AS') {
          context = 'AS';
          out.push(keyword('AS', 0));
        } else {
          context = lastKeyword === 'AS' ? 'new column name' : 'column';
          if (lastKeyword !== 'AS') out.push(...columnSuggestions(columns));
        }
        break;
      }
      case 'orders': {
        if (isOperandDone) {
          context = 'sort modifier';
          out.push(keyword('ASC', 0), keyword('DESC', 0), keyword('NULLS FIRST', 1), keyword('NULLS LAST', 1));
        } else {
          context = 'column';
          out.push(...columnSuggestions(columns), ...listFunctions((f) => f.type === 'scalar').map((f) => functionSuggestion(f, 2)));
        }
        break;
      }
      case 'policy': {
        if (lastKeyword === 'ON') {
          context = 'match column';
          out.push(...columnSuggestions(columns));
        } else if (lastKeyword === 'WITH') {
          context = 'enrich field';
        } else if (isOperandDone) {
          context = 'enrich option';
          out.push(keyword('ON', 0, 'Column to match the policy on'), keyword('WITH', 1, 'Fields to add'));
        } else {
          context = 'policy';
          out.push(...(schema.policies ?? []).map((p) => ({ label: p, insertText: p, kind: 'policy' as const, rank: 1 })));
        }
        break;
      }
      case 'lookup': {
        if (lastKeyword === 'ON') {
          context = 'join key';
          out.push(...columnSuggestions(columns));
        } else if (isOperandDone) {
          context = 'ON';
          out.push(keyword('ON', 0));
        } else {
          context = 'lookup index';
          out.push(...(schema.lookupIndices ?? []).map((p) => ({ label: p, insertText: p, kind: 'lookup' as const, rank: 1 })));
        }
        break;
      }
      case 'pattern': {
        if (prev && prev.kind === 'identifier' && isOperandDone) {
          context = 'pattern';
          out.push({ label: '"%{}"', insertText: '"%{}"', kind: 'value', rank: 0, detail: def.name === 'GROK' ? '%{SYNTAX:name}' : '%{name}', cursorDelta: -2 });
        } else {
          context = 'column';
          out.push(...columnSuggestions(columns));
        }
        break;
      }
      case 'branches': {
        context = 'fork branch';
        out.push(...PROCESSING_COMMANDS.map(commandSuggestion));
        break;
      }
      case 'assignments':
      case 'expression':
      default: {
        const isStats = def?.name === 'STATS' || def?.name === 'INLINE STATS' || def?.name === 'INLINESTATS';
        const afterBy = isStats && lastKeyword === 'BY';
        if (isOperandDone && depth === 0) {
          context = 'operator';
          out.push(...COMPARISONS.map((c, i) => ({ label: c, insertText: `${c} `, kind: 'operator' as const, rank: i })));
          out.push(...BOOLEAN_KEYWORDS.map((k) => keyword(k, 2)));
          for (const k of def?.keywords ?? []) if (!BOOLEAN_KEYWORDS.includes(k)) out.push(keyword(k, 1));
        } else {
          context = afterBy ? 'group key' : isStats ? 'aggregation' : 'expression';
          if (!isStats || afterBy || depth > 0) out.push(...columnSuggestions(columns));
          if (isStats && !afterBy) out.push(...listFunctions((f) => f.type === 'agg' || f.type === 'time_series_agg').map((f) => functionSuggestion(f, 0)));
          if (afterBy) out.push(...listFunctions((f) => f.type === 'grouping').map((f) => functionSuggestion(f, 0)));
          if (depth > 0 || !isStats || afterBy) out.push(...listFunctions((f) => f.type === 'scalar').map((f) => functionSuggestion(f, 2)));
          if (def?.argKind === 'expression') out.push(keyword('NOT', 3), keyword('TRUE', 4), keyword('FALSE', 4), keyword('NULL', 4));
        }
      }
    }
  }

  const seen = new Set<string>();
  const filtered = out
    .filter((s) => {
      if (seen.has(s.label)) return false;
      seen.add(s.label);
      if (!prefix) return true;
      const label = s.label.toLowerCase();
      return label.startsWith(prefix) || (prefix.length >= 2 && label.includes(prefix));
    })
    .map((s) => ({ ...s, rank: prefix && !s.label.toLowerCase().startsWith(prefix) ? s.rank + 10 : s.rank }))
    .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));

  return {
    suggestions: filtered.slice(0, input.limit ?? 50),
    replaceStart: start,
    replaceEnd: offset,
    context,
  };
}

/** Query text before the command under the cursor, usable as `<prefix> | LIMIT 0` for exact columns. */
export function pipelinePrefix(text: string, offset: number): string | undefined {
  const pipeIdx = lastPipeBefore(text, offset);
  if (pipeIdx <= 0) return undefined;
  const prefix = text.slice(0, pipeIdx).trim();
  return prefix || undefined;
}
