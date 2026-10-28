import {
  functionNames,
  commandNames,
  sourceCommandNames,
  processingCommandNames,
  namedBinaryOperatorNames,
  namedUnaryOperatorNames,
  sortModifierNames,
  literalNames,
  optionNames,
} from '@elastic/esql-definitions';
import snapshot from './functions.json';

export interface ParamDef {
  name: string;
  type: string;
  optional: boolean;
  description: string;
}

export interface SignatureDef {
  params: ParamDef[];
  variadic: boolean;
  returnType: string;
}

export type FunctionKind = 'scalar' | 'agg' | 'grouping' | 'time_series_agg' | 'operator';

export interface FunctionDef {
  name: string;
  type: FunctionKind;
  description: string;
  signatures: SignatureDef[];
  examples: string[];
  preview: boolean;
  snapshotOnly: boolean;
}

interface Snapshot {
  esTag: string;
  generatedAt: string;
  functions: Record<string, FunctionDef>;
  operators: Record<string, FunctionDef>;
}

const data = snapshot as unknown as Snapshot;

/** Elasticsearch tag the bundled signatures were generated from. */
export const DEFINITIONS_ES_TAG = data.esTag;

/** Upper-cased function names known to the grammar (may exceed the signature snapshot). */
export const ALL_FUNCTION_NAMES: readonly string[] = functionNames;
export const ALL_COMMAND_NAMES: readonly string[] = commandNames;
export const SOURCE_COMMAND_NAMES: readonly string[] = sourceCommandNames;
export const PROCESSING_COMMAND_NAMES: readonly string[] = processingCommandNames;
export const BINARY_OPERATOR_KEYWORDS: readonly string[] = namedBinaryOperatorNames;
export const UNARY_OPERATOR_KEYWORDS: readonly string[] = namedUnaryOperatorNames;
export const SORT_MODIFIERS: readonly string[] = sortModifierNames;
export const LITERAL_KEYWORDS: readonly string[] = literalNames;
export const OPTION_KEYWORDS: readonly string[] = optionNames;

const functionIndex = new Map<string, FunctionDef>(
  Object.values(data.functions).map((f) => [f.name.toUpperCase(), { ...f, name: f.name.toUpperCase() }]),
);
const knownNames = new Set(functionNames.map((n) => n.toUpperCase()));

/** Maps AST operator names (as @elastic/esql reports them) to operator definition keys. */
const OPERATOR_ALIASES: Record<string, string> = {
  '+': 'add',
  '-': 'sub',
  '*': 'mul',
  '/': 'div',
  '%': 'mod',
  '==': 'equals',
  '!=': 'not_equals',
  '>': 'greater_than',
  '>=': 'greater_than_or_equal',
  '<': 'less_than',
  '<=': 'less_than_or_equal',
  in: 'in',
  like: 'like',
  rlike: 'rlike',
  'is null': 'is_null',
  'is not null': 'is_not_null',
  ':': 'match_operator',
};

export function getFunction(name: string): FunctionDef | undefined {
  return functionIndex.get(name.toUpperCase());
}

export function getOperator(name: string): FunctionDef | undefined {
  const key = OPERATOR_ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  return data.operators[key];
}

/** True when the grammar knows the function, even if we have no signature for it. */
export function isKnownFunction(name: string): boolean {
  return knownNames.has(name.toUpperCase()) || functionIndex.has(name.toUpperCase());
}

export function hasSignature(name: string): boolean {
  return functionIndex.has(name.toUpperCase());
}

export function isAggregation(name: string): boolean {
  const def = getFunction(name);
  return def?.type === 'agg' || def?.type === 'time_series_agg';
}

export function isGroupingFunction(name: string): boolean {
  return getFunction(name)?.type === 'grouping';
}

export function listFunctions(filter?: (def: FunctionDef) => boolean): FunctionDef[] {
  const defs = [...functionIndex.values()];
  return (filter ? defs.filter(filter) : defs).sort((a, b) => a.name.localeCompare(b.name));
}

/** Functions present in the grammar but missing from the signature snapshot. */
export function unsnapshottedFunctionNames(): string[] {
  return [...knownNames].filter((n) => !functionIndex.has(n)).sort();
}

/** Renders a signature as `NAME(param1 type, [param2 type])`. */
export function formatSignature(def: FunctionDef, index = 0): string {
  const sig = def.signatures[index];
  if (!sig) return `${def.name}()`;
  const params = sig.params.map((p) => (p.optional ? `[${p.name} ${p.type}]` : `${p.name} ${p.type}`));
  if (sig.variadic) params.push('...');
  return `${def.name}(${params.join(', ')})${sig.returnType ? ` -> ${sig.returnType}` : ''}`;
}

/** Arity bounds across all signatures: [min, max] where max may be Infinity. */
export function arity(def: FunctionDef): [number, number] {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const sig of def.signatures) {
    const required = sig.params.filter((p) => !p.optional).length;
    min = Math.min(min, required);
    max = sig.variadic ? Number.POSITIVE_INFINITY : Math.max(max, sig.params.length);
  }
  if (!Number.isFinite(min)) min = 0;
  return [min, max];
}
