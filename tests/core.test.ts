import { describe, expect, it } from 'vitest';
import { parseQuery } from '../src/core/ast.js';
import { computeColumnFlow, inferType } from '../src/core/columns.js';
import { formatQuery } from '../src/core/format.js';
import { tokenize } from '../src/core/tokenize.js';
import { lookupDoc } from '../src/core/docs.js';
import { backspace, insert, insertPipe, looksRunnable, moveVertical } from '../src/ui/editor-model.js';

describe('column flow', () => {
  const fields = [
    { name: 'bytes', type: 'long' },
    { name: 'host.name', type: 'keyword' },
    { name: '@timestamp', type: 'date' },
  ];
  it('infers types for EVAL and STATS columns', () => {
    const { commands } = parseQuery('FROM logs-* | EVAL kb = bytes / 1024, d = DATE_TRUNC(1 hour, @timestamp) | STATS c = COUNT(*), m = MAX(kb) BY d');
    const flow = computeColumnFlow(commands, fields);
    expect(flow.after[1].columns.get('kb')).toBe('long');
    expect(flow.after[1].columns.get('d')).toBe('date');
    expect([...flow.after[2].columns.keys()]).toEqual(['c', 'm', 'd']);
    expect(flow.after[2].columns.get('c')).toBe('long');
  });
  it('marks the environment unknown after ENRICH without WITH', () => {
    const { commands } = parseQuery('FROM logs-* | ENRICH geo ON host.name | KEEP country');
    const flow = computeColumnFlow(commands, fields);
    expect(flow.after[1].known).toBe(false);
  });
  it('infers literal types', () => {
    const { commands } = parseQuery('ROW a = 1, b = 1.5, c = "x", d = true');
    const env = computeColumnFlow(commands).after[0];
    expect([...env.columns.values()]).toEqual(['integer', 'double', 'keyword', 'boolean']);
    expect(inferType(undefined, env)).toBe('unknown');
  });
});

describe('tokenize', () => {
  it('classifies commands, functions, keywords, strings, and pipes', () => {
    const kinds = tokenize('FROM logs-* | WHERE a LIKE "x*" AND COUNT(b) > 1 // note').filter((t) => t.kind !== 'whitespace').map((t) => t.kind);
    expect(kinds).toEqual(['command', 'identifier', 'pipe', 'command', 'identifier', 'keyword', 'string', 'keyword', 'function', 'punct', 'identifier', 'punct', 'operator', 'number', 'comment']);
  });
  it('treats INLINE STATS and LOOKUP JOIN as commands', () => {
    const kinds = tokenize('FROM a | INLINE STATS c = COUNT(*) | LOOKUP JOIN b ON k').filter((t) => t.kind === 'command').map((t) => t.text);
    expect(kinds).toEqual(['FROM', 'INLINE', 'STATS', 'LOOKUP', 'JOIN']);
  });
});

describe('format', () => {
  it('puts each command on its own line', () => {
    expect(formatQuery('from a | where b > 1 | limit 5').text).toBe('FROM a\n  | WHERE b > 1\n  | LIMIT 5');
    expect(formatQuery('FROM a | LIMIT 5', { inline: true }).text).toBe('FROM a | LIMIT 5');
  });
  it('leaves broken queries untouched', () => {
    const res = formatQuery('FROM a | WHERE');
    expect(res.error).toBeDefined();
    expect(res.text).toBe('FROM a | WHERE');
  });
});

describe('docs', () => {
  it('renders function and command references', () => {
    expect(lookupDoc('date_trunc')?.signatures[0]).toContain('DATE_TRUNC(');
    expect(lookupDoc('stats')?.kind).toBe('command');
    expect(lookupDoc('nope')).toBeUndefined();
  });
});

describe('editor model', () => {
  it('starts a new piped command on its own line', () => {
    expect(insertPipe({ text: 'FROM a ', cursor: 7 })).toEqual({ text: 'FROM a\n  | ', cursor: 11 });
    expect(insertPipe({ text: 'FROM a | WHERE x == "a', cursor: 22 }).text).toBe('FROM a | WHERE x == "a|');
  });
  it('knows when a query is runnable', () => {
    expect(looksRunnable('FROM a | LIMIT 1')).toBe(true);
    expect(looksRunnable('FROM a |')).toBe(false);
    expect(looksRunnable('FROM a | EVAL x = ROUND(')).toBe(false);
  });
  it('edits and moves', () => {
    const s = insert({ text: 'ab', cursor: 1 }, 'X');
    expect(s).toEqual({ text: 'aXb', cursor: 2 });
    expect(backspace(s)).toEqual({ text: 'ab', cursor: 1 });
    expect(moveVertical({ text: 'abc\ndef', cursor: 5 }, -1)?.cursor).toBe(1);
    expect(moveVertical({ text: 'abc', cursor: 1 }, 1)).toBeUndefined();
  });
});
