import { getCommand } from '../definitions/commands.js';
import { getFunction, getOperator } from '../definitions/index.js';
import {
  flattenArgs,
  isAssignment,
  isColumn,
  isFunction,
  isLiteral,
  isOption,
  literalValue,
  type ESQLCommand,
  type ESQLSingleAstItem,
} from './ast.js';
import type { Field } from './types.js';

export interface ColumnEnv {
  /** Column name -> ES|QL type (`unknown` when not inferable). */
  columns: Map<string, string>;
  /** False when columns may exist that we cannot name (no schema, GROK, ENRICH, ...). */
  known: boolean;
}

export interface ColumnFlow {
  /** Environment visible to command `i` (what its expressions may reference). */
  before: ColumnEnv[];
  /** Environment produced by command `i`. */
  after: ColumnEnv[];
}

const METADATA_FIELDS: Record<string, string> = {
  _index: 'keyword',
  _id: 'keyword',
  _version: 'long',
  _score: 'double',
  _source: '_source',
  _ignored: 'keyword',
  _index_mode: 'keyword',
};

const clone = (env: ColumnEnv): ColumnEnv => ({ columns: new Map(env.columns), known: env.known });

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
}

const NUMERIC = new Set(['integer', 'long', 'double', 'unsigned_long', 'counter_integer', 'counter_long', 'counter_double']);

function numericWidest(a: string, b: string): string {
  if (a === 'double' || b === 'double') return 'double';
  if (a === 'unsigned_long' || b === 'unsigned_long') return 'unsigned_long';
  if (a === 'long' || b === 'long') return 'long';
  return 'integer';
}

/** Best-effort static type of an expression. */
export function inferType(node: ESQLSingleAstItem | undefined, env: ColumnEnv): string {
  if (!node) return 'unknown';
  if (isLiteral(node)) {
    switch (node.literalType) {
      case 'integer':
        return 'integer';
      case 'double':
        return 'double';
      case 'keyword':
        return 'keyword';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'time_duration':
        return 'time_duration';
      case 'date_period':
        return 'date_period';
      case 'param':
        return 'unknown';
      default:
        return 'unknown';
    }
  }
  if (isColumn(node)) return env.columns.get(node.name) ?? 'unknown';
  if (node.type === 'inlineCast') return String((node as { castType?: string }).castType ?? 'unknown');
  if (isFunction(node)) {
    const args = flattenArgs(node.args);
    const name = node.name.toLowerCase();
    if (node.subtype === 'binary-expression' || node.subtype === 'unary-expression' || node.subtype === 'postfix-unary-expression') {
      if (['and', 'or', 'not', '==', '!=', '>', '>=', '<', '<=', 'in', 'like', 'rlike', 'is null', 'is not null', ':'].includes(name)) return 'boolean';
      if (['+', '-', '*', '/', '%'].includes(name)) {
        const types = args.map((a) => inferType(a, env));
        if (types.some((t) => t === 'date' || t === 'date_nanos')) return 'date';
        if (types.every((t) => NUMERIC.has(t))) return types.reduce(numericWidest);
        return 'unknown';
      }
      const op = getOperator(name);
      const ret = op?.signatures.map((s) => s.returnType);
      return ret && ret.every((r) => r === ret[0]) ? ret[0] : 'unknown';
    }
    const def = getFunction(node.name);
    if (!def) return 'unknown';
    const argTypes = args.map((a) => inferType(a, env));
    const exact = def.signatures.find((sig) => sig.params.every((p, i) => argTypes[i] === undefined ? p.optional : p.type === argTypes[i] || p.type === 'any'));
    if (exact?.returnType) return exact.returnType;
    const returns = new Set(def.signatures.map((s) => s.returnType));
    return returns.size === 1 ? [...returns][0] : 'unknown';
  }
  return 'unknown';
}

function dissectNames(pattern: string): string[] {
  const names: string[] = [];
  for (const m of pattern.matchAll(/%\{([^}]*)\}/g)) {
    const key = m[1].replace(/^[+?&]/, '').split(/[/:]/)[0].trim();
    if (key && !m[1].startsWith('?')) names.push(key);
  }
  return names;
}

function grokFields(pattern: string): Field[] {
  const fields: Field[] = [];
  for (const m of pattern.matchAll(/%\{([A-Z0-9_]+)(?::([^}:]+))?(?::([a-z]+))?\}/g)) {
    if (m[2]) fields.push({ name: m[2], type: m[3] === 'int' ? 'integer' : m[3] === 'float' ? 'double' : m[3] ?? 'keyword' });
  }
  for (const m of pattern.matchAll(/\(\?<([A-Za-z0-9_]+)>/g)) fields.push({ name: m[1], type: 'keyword' });
  return fields;
}

/** Name a command would give a bare expression column, e.g. `COUNT(*)`. */
export function expressionColumnName(node: ESQLSingleAstItem): string {
  return node.text?.trim() || node.name;
}

function applyAssignments(items: ESQLSingleAstItem[], env: ColumnEnv, target: ColumnEnv): void {
  for (const item of items) {
    if (isOption(item)) continue;
    if (isAssignment(item)) {
      const [lhs, ...rest] = flattenArgs(item.args);
      const rhs = rest[0];
      if (isColumn(lhs)) target.columns.set(lhs.name, inferType(rhs, env));
    } else {
      target.columns.set(expressionColumnName(item), inferType(item, env));
    }
  }
}

export function computeColumnFlow(commands: ESQLCommand[], baseFields?: Field[]): ColumnFlow {
  const before: ColumnEnv[] = [];
  const after: ColumnEnv[] = [];
  let env: ColumnEnv = { columns: new Map(), known: false };

  commands.forEach((command) => {
    before.push(clone(env));
    const def = getCommand(command.name, command.commandType);
    const args = flattenArgs(command.args);
    const next = clone(env);
    const name = command.name.toLowerCase();

    switch (name) {
      case 'from':
      case 'ts': {
        next.columns = new Map((baseFields ?? []).map((f) => [f.name, f.type]));
        next.known = Boolean(baseFields);
        const metadata = args.find((a) => isOption(a) && a.name === 'metadata');
        if (metadata && isOption(metadata)) {
          for (const col of flattenArgs(metadata.args)) if (isColumn(col)) next.columns.set(col.name, METADATA_FIELDS[col.name] ?? 'keyword');
        }
        break;
      }
      case 'row':
        next.columns = new Map();
        next.known = true;
        applyAssignments(args, env, next);
        break;
      case 'show':
        next.columns = new Map([['version', 'keyword'], ['date', 'date'], ['hash', 'keyword']]);
        next.known = true;
        break;
      case 'eval':
      case 'inlinestats':
      case 'inline stats':
        applyAssignments(args.filter((a) => !isOption(a)), env, next);
        for (const by of args.filter((a) => isOption(a) && a.name === 'by')) applyAssignments(flattenArgs((by as { args: ESQLSingleAstItem[] }).args), env, next);
        break;
      case 'stats': {
        next.columns = new Map();
        next.known = true;
        applyAssignments(args.filter((a) => !isOption(a)), env, next);
        for (const by of args.filter((a) => isOption(a) && a.name === 'by')) applyAssignments(flattenArgs((by as { args: ESQLSingleAstItem[] }).args), env, next);
        break;
      }
      case 'keep': {
        const kept = new Map<string, string>();
        for (const col of args) {
          if (!isColumn(col)) continue;
          if (col.name.includes('*')) {
            const re = globToRegExp(col.name);
            for (const [k, v] of env.columns) if (re.test(k)) kept.set(k, v);
            if (!env.known) kept.set(col.name, 'unknown');
          } else {
            kept.set(col.name, env.columns.get(col.name) ?? 'unknown');
          }
        }
        next.columns = kept;
        break;
      }
      case 'drop':
        for (const col of args) {
          if (!isColumn(col)) continue;
          if (col.name.includes('*')) {
            const re = globToRegExp(col.name);
            for (const k of [...next.columns.keys()]) if (re.test(k)) next.columns.delete(k);
          } else next.columns.delete(col.name);
        }
        break;
      case 'rename':
        for (const item of args) {
          if (!isFunction(item) || (item.name !== 'as' && item.name !== '=')) continue;
          const [a, b] = flattenArgs(item.args);
          const [from, to] = item.name === 'as' ? [a, b] : [b, a];
          if (isColumn(from) && isColumn(to)) {
            const type = next.columns.get(from.name) ?? 'unknown';
            next.columns.delete(from.name);
            next.columns.set(to.name, type);
          }
        }
        break;
      case 'dissect':
      case 'grok': {
        const pattern = args.find(isLiteral);
        if (pattern) {
          const text = literalValue(pattern);
          const fields = name === 'grok' ? grokFields(text) : dissectNames(text).map((n) => ({ name: n, type: 'keyword' }));
          for (const f of fields) next.columns.set(f.name, f.type);
        }
        break;
      }
      case 'enrich': {
        const withOpt = args.find((a) => isOption(a) && a.name === 'with');
        if (withOpt && isOption(withOpt)) {
          for (const item of flattenArgs(withOpt.args)) {
            if (isAssignment(item)) {
              const [lhs] = flattenArgs(item.args);
              if (isColumn(lhs)) next.columns.set(lhs.name, 'unknown');
            } else if (isColumn(item)) next.columns.set(item.name, 'unknown');
          }
        } else next.known = false;
        break;
      }
      case 'change_point': {
        const asOpt = args.find((a) => isOption(a) && a.name === 'as');
        const names = asOpt && isOption(asOpt) ? flattenArgs(asOpt.args).filter(isColumn).map((c) => c.name) : ['type', 'pvalue'];
        next.columns.set(names[0] ?? 'type', 'keyword');
        next.columns.set(names[1] ?? 'pvalue', 'double');
        break;
      }
      case 'completion':
      case 'rerank':
        applyAssignments(args.filter((a) => isAssignment(a)), env, next);
        if (!args.some(isAssignment)) next.columns.set(name === 'rerank' ? '_score' : 'completion', name === 'rerank' ? 'double' : 'keyword');
        break;
      case 'fork':
        next.columns.set('_fork', 'keyword');
        next.known = false;
        break;
      default:
        if (def?.columnEffect === 'add-unknown' || def?.columnEffect === 'unknown') next.known = false;
    }

    after.push(next);
    env = next;
  });

  return { before, after };
}
