import { Parser } from '@elastic/esql';
import type {
  ESQLAstItem,
  ESQLAstQueryExpression,
  ESQLColumn,
  ESQLCommand,
  ESQLCommandOption,
  ESQLFunction,
  ESQLLiteral,
  ESQLOrderExpression,
  ESQLProperNode,
  ESQLSingleAstItem,
  ESQLSource,
} from '@elastic/esql/types';
import { indexLines, offsetToPosition, positionToOffset, type Diagnostic } from './types.js';

export type {
  ESQLAstItem,
  ESQLAstQueryExpression,
  ESQLColumn,
  ESQLCommand,
  ESQLCommandOption,
  ESQLFunction,
  ESQLLiteral,
  ESQLOrderExpression,
  ESQLProperNode,
  ESQLSingleAstItem,
  ESQLSource,
};

export interface ParsedQuery {
  text: string;
  root: ESQLAstQueryExpression;
  commands: ESQLCommand[];
  /** Syntax errors reported by the ANTLR parser, as diagnostics. */
  syntaxErrors: Diagnostic[];
}

export function parseQuery(text: string): ParsedQuery {
  const result = Parser.parse(text, { withFormatting: true });
  const lines = indexLines(text);
  const syntaxErrors: Diagnostic[] = result.errors.map((e) => {
    const start = positionToOffset(lines, e.startLineNumber, e.startColumn);
    const end = Math.max(start + 1, positionToOffset(lines, e.endLineNumber, e.endColumn));
    const pos = offsetToPosition(lines, start);
    return {
      code: 'E001',
      rule: 'syntax',
      severity: 'error',
      message: e.message.replace(/^SyntaxError:\s*/, ''),
      start,
      end,
      line: pos.line,
      column: pos.column,
    };
  });
  return { text, root: result.root, commands: result.root.commands, syntaxErrors };
}

/** Command args can be nested arrays; this returns the proper nodes in order. */
export function flattenArgs(items: ESQLAstItem[] | undefined): ESQLSingleAstItem[] {
  const out: ESQLSingleAstItem[] = [];
  const visit = (item: ESQLAstItem) => {
    if (Array.isArray(item)) item.forEach(visit);
    else if (item) out.push(item);
  };
  (items ?? []).forEach(visit);
  return out;
}

export const isColumn = (n: ESQLSingleAstItem | undefined): n is ESQLColumn => n?.type === 'column';
export const isFunction = (n: ESQLSingleAstItem | undefined): n is ESQLFunction => n?.type === 'function';
export const isLiteral = (n: ESQLSingleAstItem | undefined): n is ESQLLiteral => n?.type === 'literal';
export const isSource = (n: ESQLSingleAstItem | undefined): n is ESQLSource => n?.type === 'source';
export const isOption = (n: ESQLSingleAstItem | undefined): n is ESQLCommandOption => n?.type === 'option';
export const isOrder = (n: ESQLSingleAstItem | undefined): n is ESQLOrderExpression => n?.type === 'order';

export function isAssignment(n: ESQLSingleAstItem | undefined): n is ESQLFunction {
  return isFunction(n) && n.name === '=';
}

export function isFunctionCall(n: ESQLSingleAstItem | undefined): n is ESQLFunction {
  return isFunction(n) && (n.subtype === undefined || n.subtype === 'variadic-call');
}

/** Depth-first walk over every proper node below `node` (inclusive). */
export function walkNodes(node: ESQLAstItem | ESQLAstQueryExpression | ESQLCommand, visit: (n: ESQLSingleAstItem, parent?: ESQLSingleAstItem) => void, parent?: ESQLSingleAstItem): void {
  if (Array.isArray(node)) {
    for (const child of node) walkNodes(child, visit, parent);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node.type === 'query') {
    for (const cmd of (node as ESQLAstQueryExpression).commands) walkNodes(cmd, visit, undefined);
    return;
  }
  const single = node as ESQLSingleAstItem;
  visit(single, parent);
  const args = (single as { args?: ESQLAstItem[] }).args;
  if (args) for (const child of args) walkNodes(child, visit, single);
}

/** Returns the top-level command containing `offset`, or the last command before it. */
export function commandAt(commands: ESQLCommand[], offset: number): { command: ESQLCommand; index: number } | undefined {
  let best: { command: ESQLCommand; index: number } | undefined;
  commands.forEach((command, index) => {
    if (command.location.min <= offset) best = { command, index };
  });
  return best;
}

/** Command name as the user would write it, e.g. `lookup join`. */
export function commandDisplayName(command: ESQLCommand): string {
  if (command.name === 'join') return `${command.commandType ?? 'lookup'} join`;
  return command.name;
}

export function nodeEnd(node: { location: { min: number; max: number } }): number {
  return node.location.max + 1;
}

export function literalValue(node: ESQLLiteral): string {
  const raw = String(node.value ?? node.name ?? '');
  if (node.literalType === 'keyword') return raw.replace(/^"""|"""$/g, '').replace(/^"|"$/g, '');
  return raw;
}
