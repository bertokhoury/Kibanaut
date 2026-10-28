import { getCommand } from '../../definitions/commands.js';
import { arity, getFunction, hasSignature, isAggregation, isKnownFunction } from '../../definitions/index.js';
import {
  commandDisplayName,
  flattenArgs,
  isAssignment,
  isColumn,
  isFunction,
  isFunctionCall,
  isLiteral,
  isOption,
  isSource,
  nodeEnd,
  walkNodes,
  type ESQLCommand,
  type ESQLSingleAstItem,
  type ParsedQuery,
} from '../ast.js';
import { inferType, type ColumnFlow } from '../columns.js';
import { tokenize } from '../tokenize.js';
import type { Diagnostic, Severity } from '../types.js';

export interface RuleMeta {
  code: string;
  name: string;
  severity: Severity;
  summary: string;
  fixable?: boolean;
}

export interface RuleContext {
  parsed: ParsedQuery;
  flow: ColumnFlow;
  /** True when the FROM/TS source fields are known (schema available). */
  hasSchema: boolean;
  functionCase: 'upper' | 'lower' | 'ignore';
}

export type RawDiagnostic = Omit<Diagnostic, 'line' | 'column' | 'code' | 'rule' | 'severity'> & { severity?: Severity };

export interface Rule {
  meta: RuleMeta;
  run(ctx: RuleContext): RawDiagnostic[];
}

const LITERAL_TYPE_ALIASES: Record<string, string[]> = {
  integer: ['integer', 'long', 'double', 'unsigned_long'],
  long: ['long', 'double', 'unsigned_long'],
  double: ['double'],
  keyword: ['keyword', 'text'],
  text: ['text', 'keyword'],
  boolean: ['boolean'],
  date: ['date', 'date_nanos'],
  date_nanos: ['date_nanos', 'date'],
  time_duration: ['time_duration', 'date_period'],
  date_period: ['date_period', 'time_duration'],
  ip: ['ip'],
  version: ['version'],
};

function typeAccepts(paramType: string, actual: string): boolean {
  if (paramType === 'any' || actual === 'unknown' || actual === 'null') return true;
  if (paramType === actual) return true;
  const aliases = LITERAL_TYPE_ALIASES[actual] ?? [actual];
  return aliases.includes(paramType);
}

function span(node: { location: { min: number; max: number } }): { start: number; end: number } {
  return { start: node.location.min, end: Math.max(node.location.min + 1, nodeEnd(node)) };
}

function commandsAfter(commands: ESQLCommand[], index: number): ESQLCommand[] {
  return commands.slice(index + 1);
}

function referencesColumn(command: ESQLCommand, name: string): boolean {
  let found = false;
  walkNodes(command, (n, parent) => {
    if (found || !isColumn(n) || n.name !== name) return;
    // Assignment targets are definitions, not references.
    if (parent && isAssignment(parent) && flattenArgs(parent.args)[0] === n) return;
    found = true;
  });
  return found;
}

export const RULES: Rule[] = [
  {
    meta: { code: 'E002', name: 'unknown-function', severity: 'error', summary: 'Function name is not known to the ES|QL grammar' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      walkNodes(parsed.root, (n) => {
        if (!isFunctionCall(n) || n.name === '=' || isKnownFunction(n.name)) return;
        out.push({ ...span(n), message: `Unknown function ${n.name.toUpperCase()}()` });
      });
      return out;
    },
  },
  {
    meta: { code: 'E003', name: 'arity', severity: 'error', summary: 'Wrong number of arguments for a function' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      walkNodes(parsed.root, (n) => {
        if (!isFunctionCall(n) || !hasSignature(n.name)) return;
        const def = getFunction(n.name)!;
        const [min, max] = arity(def);
        const count = flattenArgs(n.args).length;
        if (count < min || count > max) {
          const expected = max === Number.POSITIVE_INFINITY ? `at least ${min}` : min === max ? `${min}` : `${min} to ${max}`;
          out.push({ ...span(n), message: `${def.name}() expects ${expected} argument${min === 1 && max === 1 ? '' : 's'}, got ${count}` });
        }
      });
      return out;
    },
  },
  {
    meta: { code: 'E004', name: 'argument-type', severity: 'error', summary: 'Argument type does not match any signature' },
    run({ parsed, flow }) {
      const out: RawDiagnostic[] = [];
      parsed.commands.forEach((command, i) => {
        const env = flow.before[i];
        walkNodes(command, (n) => {
          if (!isFunctionCall(n) || !hasSignature(n.name)) return;
          const def = getFunction(n.name)!;
          const args = flattenArgs(n.args);
          const types = args.map((a) => inferType(a, env));
          if (types.every((t) => t === 'unknown')) return;
          const fits = def.signatures.some((sig) =>
            types.every((t, idx) => {
              const param = sig.params[idx] ?? (sig.variadic ? sig.params[sig.params.length - 1] : undefined);
              return param ? typeAccepts(param.type, t) : false;
            }),
          );
          if (fits) return;
          const badIndex = types.findIndex((t, idx) => !def.signatures.some((sig) => {
            const param = sig.params[idx] ?? (sig.variadic ? sig.params[sig.params.length - 1] : undefined);
            return param ? typeAccepts(param.type, t) : false;
          }));
          const target = badIndex >= 0 ? args[badIndex] : n;
          const accepted = [...new Set(def.signatures.map((s) => s.params[Math.max(badIndex, 0)]?.type).filter(Boolean))];
          out.push({
            ...span(target),
            message: `${def.name}() argument ${Math.max(badIndex, 0) + 1} is ${types[Math.max(badIndex, 0)]}; expected ${accepted.join(' | ') || 'a different type'}`,
          });
        });
      });
      return out;
    },
  },
  {
    meta: { code: 'E005', name: 'unknown-column', severity: 'error', summary: 'Column does not exist at this point in the pipeline' },
    run({ parsed, flow }) {
      const out: RawDiagnostic[] = [];
      parsed.commands.forEach((command, i) => {
        const env = flow.before[i];
        if (!env.known) return;
        const name = command.name.toLowerCase();
        if (['from', 'ts', 'row', 'show', 'fork', 'explain', 'promql'].includes(name)) return;
        walkNodes(command, (n, parent) => {
          if (!isColumn(n) || n.name.includes('*') || n.name === '') return;
          if (parent && isAssignment(parent) && flattenArgs(parent.args)[0] === n) return;
          if (parent && isFunction(parent) && parent.name === 'as' && flattenArgs(parent.args)[1] === n) return;
          if (parent && isOption(parent) && ['with', 'metadata', 'as'].includes(parent.name)) return;
          if (name === 'enrich' && parent && isOption(parent) && parent.name === 'on') {
            if (!env.columns.has(n.name)) out.push({ ...span(n), message: `Unknown column ${n.name}` });
            return;
          }
          if (env.columns.has(n.name)) return;
          const suggestion = closest(n.name, [...env.columns.keys()]);
          out.push({ ...span(n), message: `Unknown column ${n.name}${suggestion ? `; did you mean ${suggestion}?` : ''}` });
        });
      });
      return out;
    },
  },
  {
    meta: { code: 'E006', name: 'aggregation-outside-stats', severity: 'error', summary: 'Aggregation functions are only valid in STATS' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      for (const command of parsed.commands) {
        const name = command.name.toLowerCase();
        if (['stats', 'inlinestats', 'inline stats', 'ts'].includes(name)) continue;
        walkNodes(command, (n) => {
          if (isFunctionCall(n) && isAggregation(n.name)) {
            out.push({ ...span(n), message: `${n.name.toUpperCase()}() is an aggregation; use it inside STATS, not ${commandDisplayName(command).toUpperCase()}` });
          }
        });
      }
      return out;
    },
  },
  {
    meta: { code: 'E007', name: 'nested-aggregation', severity: 'error', summary: 'Aggregations cannot be nested' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      for (const command of parsed.commands) {
        if (!['stats', 'inlinestats', 'inline stats'].includes(command.name.toLowerCase())) continue;
        const inside: ESQLSingleAstItem[] = [];
        const visit = (n: ESQLSingleAstItem) => {
          const isAgg = isFunctionCall(n) && isAggregation(n.name);
          if (isAgg && inside.length) out.push({ ...span(n), message: `${n.name.toUpperCase()}() cannot be nested inside ${inside[0].name.toUpperCase()}()` });
          if (isAgg) inside.push(n);
          for (const child of flattenArgs((n as { args?: ESQLSingleAstItem[] }).args)) visit(child);
          if (isAgg) inside.pop();
        };
        for (const arg of flattenArgs(command.args)) visit(arg);
      }
      return out;
    },
  },
  {
    meta: { code: 'W101', name: 'no-implicit-limit', severity: 'warning', summary: 'Add an explicit LIMIT; Elasticsearch silently caps results at 1000 rows' },
    run({ parsed }) {
      const names = parsed.commands.map((c) => c.name.toLowerCase());
      if (!names.some((n) => n === 'from' || n === 'ts')) return [];
      if (names.includes('limit')) return [];
      const stats = parsed.commands.find((c) => c.name.toLowerCase() === 'stats');
      if (stats && !flattenArgs(stats.args).some((a) => isOption(a) && a.name === 'by')) return [];
      const last = parsed.commands[parsed.commands.length - 1];
      return [{ start: last.location.min, end: last.location.min + commandDisplayName(last).length, message: 'No LIMIT: results are capped at 1000 rows by default and the cap is silent. Add an explicit LIMIT.' }];
    },
  },
  {
    meta: { code: 'W102', name: 'sort-without-limit', severity: 'warning', summary: 'SORT without a following LIMIT sorts the whole result set' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      parsed.commands.forEach((command, i) => {
        if (command.name.toLowerCase() !== 'sort') return;
        if (commandsAfter(parsed.commands, i).some((c) => c.name.toLowerCase() === 'limit')) return;
        out.push({ start: command.location.min, end: command.location.min + 4, message: 'SORT with no LIMIT afterwards sorts every row; add a LIMIT to keep the sort bounded.' });
      });
      return out;
    },
  },
  {
    meta: { code: 'W103', name: 'unused-eval-column', severity: 'warning', summary: 'EVAL column is never used and does not reach the output' },
    run({ parsed, flow }) {
      const out: RawDiagnostic[] = [];
      const finalEnv = flow.after[flow.after.length - 1];
      parsed.commands.forEach((command, i) => {
        if (command.name.toLowerCase() !== 'eval') return;
        for (const item of flattenArgs(command.args)) {
          if (!isAssignment(item)) continue;
          const [lhs] = flattenArgs(item.args);
          if (!isColumn(lhs)) continue;
          const later = commandsAfter(parsed.commands, i);
          const used = later.some((c) => referencesColumn(c, lhs.name));
          if (used) continue;
          if (finalEnv && finalEnv.columns.has(lhs.name)) continue;
          if (!later.length) continue;
          out.push({ ...span(lhs), message: `${lhs.name} is computed but never used and dropped before the output` });
        }
      });
      return out;
    },
  },
  {
    meta: { code: 'W104', name: 'filter-on-group-after-stats', severity: 'warning', summary: 'A WHERE on group keys can run before STATS to aggregate fewer rows' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      parsed.commands.forEach((command, i) => {
        if (command.name.toLowerCase() !== 'where' || i === 0) return;
        const prev = parsed.commands[i - 1];
        if (prev.name.toLowerCase() !== 'stats') return;
        const by = flattenArgs(prev.args).find((a) => isOption(a) && a.name === 'by');
        if (!by || !isOption(by)) return;
        const groupKeys = new Set(flattenArgs(by.args).filter(isColumn).map((c) => c.name));
        if (!groupKeys.size) return;
        const refs: string[] = [];
        walkNodes(command, (n) => {
          if (isColumn(n)) refs.push(n.name);
        });
        if (refs.length && refs.every((r) => groupKeys.has(r))) {
          out.push({ ...span(command), message: 'This WHERE only tests STATS group keys; move it before STATS so fewer rows are aggregated.' });
        }
      });
      return out;
    },
  },
  {
    meta: { code: 'W105', name: 'preview-function', severity: 'warning', summary: 'Function is in technical preview and may change' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      walkNodes(parsed.root, (n) => {
        if (!isFunctionCall(n)) return;
        const def = getFunction(n.name);
        if (def?.snapshotOnly) out.push({ ...span(n), message: `${def.name}() only exists in snapshot builds of Elasticsearch` });
        else if (def?.preview) out.push({ ...span(n), message: `${def.name}() is in technical preview; its behavior may change` });
      });
      return out;
    },
  },
  {
    meta: { code: 'W106', name: 'wildcard-source', severity: 'warning', summary: 'FROM * reads every index in the cluster' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      for (const command of parsed.commands) {
        if (!['from', 'ts'].includes(command.name.toLowerCase())) continue;
        for (const src of flattenArgs(command.args)) {
          if (isSource(src) && /^\*+$/.test(src.name)) out.push({ ...span(src), message: 'FROM * scans every index, including system and hidden ones you may not want' });
        }
      }
      return out;
    },
  },
  {
    meta: { code: 'W107', name: 'limit-above-cap', severity: 'warning', summary: 'LIMIT above 10000 is capped by esql.query.result_truncation_max_size' },
    run({ parsed }) {
      const out: RawDiagnostic[] = [];
      for (const command of parsed.commands) {
        if (command.name.toLowerCase() !== 'limit') continue;
        const lit = flattenArgs(command.args).find(isLiteral);
        if (lit && typeof lit.value === 'number' && lit.value > 10000) out.push({ ...span(lit), message: `LIMIT ${lit.value} exceeds the default 10000 row cap (esql.query.result_truncation_max_size)` });
      }
      return out;
    },
  },
  {
    meta: { code: 'S201', name: 'keyword-case', severity: 'info', summary: 'Commands and keywords are conventionally upper case', fixable: true },
    run({ parsed, functionCase }) {
      // One diagnostic per line, listing every offending token on it.
      const byLine = new Map<number, { start: number; end: number; wanted: string[] }>();
      let lineNo = 1;
      let lineStart = 0;
      const text = parsed.text;
      const tokens = tokenize(text);
      for (const t of tokens) {
        lineNo += (text.slice(lineStart, t.start).match(/\n/g) ?? []).length;
        lineStart = t.start;
        let want: string | undefined;
        if ((t.kind === 'command' || t.kind === 'keyword') && t.text !== t.text.toUpperCase()) want = t.text.toUpperCase();
        if (t.kind === 'function' && functionCase !== 'ignore') {
          const w = functionCase === 'upper' ? t.text.toUpperCase() : t.text.toLowerCase();
          if (t.text !== w) want = w;
        }
        if (!want) continue;
        const entry = byLine.get(lineNo);
        if (entry) {
          entry.end = t.end;
          entry.wanted.push(want);
        } else byLine.set(lineNo, { start: t.start, end: t.end, wanted: [want] });
      }
      return [...byLine.values()].map((e) => ({ start: e.start, end: e.end, message: `Write ${[...new Set(e.wanted)].join(', ')} in ${functionCase === 'lower' && e.wanted.every((w) => w === w.toLowerCase()) ? 'lower' : 'upper'} case` }));
    },
  },
  {
    meta: { code: 'S202', name: 'one-command-per-line', severity: 'info', summary: 'Put each piped command on its own line', fixable: true },
    run({ parsed }) {
      if (parsed.commands.length < 2) return [];
      const text = parsed.text;
      const crowded: ESQLCommand[] = [];
      for (let i = 1; i < parsed.commands.length; i++) {
        const between = text.slice(nodeEnd(parsed.commands[i - 1]), parsed.commands[i].location.min);
        if (!between.includes('\n')) crowded.push(parsed.commands[i]);
      }
      if (!crowded.length) return [];
      const first = crowded[0];
      const names = crowded.map((c) => commandDisplayName(c).toUpperCase());
      return [{ start: first.location.min, end: first.location.min + first.name.length, message: `Put ${names.length === 1 ? names[0] : `${names.length} piped commands (${names.join(', ')})`} on ${names.length === 1 ? 'its' : 'their'} own line${names.length === 1 ? '' : 's'} (kibanaut fmt)` }];
    },
  },
];

export const RULE_BY_NAME = new Map(RULES.map((r) => [r.meta.name, r]));
export const RULE_BY_CODE = new Map(RULES.map((r) => [r.meta.code, r]));

/** Damerau-ish closest match for "did you mean" hints. */
export function closest(target: string, candidates: string[]): string | undefined {
  let best: string | undefined;
  let bestScore = Number.POSITIVE_INFINITY;
  const t = target.toLowerCase();
  for (const c of candidates) {
    const d = editDistance(t, c.toLowerCase());
    if (d < bestScore && d <= Math.max(2, Math.floor(t.length / 3))) {
      bestScore = d;
      best = c;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + 1);
    }
  }
  return dp[a.length][b.length];
}

export function describeCommandKeywords(command: ESQLCommand): string[] {
  return getCommand(command.name, command.commandType)?.keywords ?? [];
}
