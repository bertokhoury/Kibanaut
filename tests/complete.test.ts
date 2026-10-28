import { describe, expect, it } from 'vitest';
import { complete, pipelinePrefix } from '../src/core/complete.js';
import type { Field } from '../src/core/types.js';

const columns: Field[] = [
  { name: '@timestamp', type: 'date' },
  { name: 'host.name', type: 'keyword' },
  { name: 'bytes', type: 'long' },
];
const schema = { columns, sources: ['logs-*', 'metrics-*'], policies: ['geoip'], lookupIndices: ['hosts_lookup'] };
const labels = (text: string, offset = text.length) => complete({ text, offset, schema }).suggestions.map((s) => s.label);

describe('complete', () => {
  it('offers source commands on an empty query and processing commands after a pipe', () => {
    expect(labels('')).toContain('FROM');
    expect(labels('')).not.toContain('WHERE');
    const after = labels('FROM logs-* | ');
    expect(after.slice(0, 3)).toEqual(['WHERE', 'STATS', 'EVAL']);
  });

  it('completes two-word commands', () => {
    expect(labels('FROM logs-* | LOOKUP ')).toContain('JOIN');
  });

  it('suggests indices in FROM and METADATA after a source', () => {
    expect(labels('FROM lo')).toEqual(['logs-*']);
    expect(labels('FROM logs-* ')).toContain('METADATA');
    expect(labels('FROM logs-* METADATA ')).toContain('_id');
  });

  it('suggests aggregations in STATS and columns after BY', () => {
    const stats = complete({ text: 'FROM logs-* | STATS ', offset: 20, schema });
    expect(stats.context).toBe('aggregation');
    expect(stats.suggestions[0].kind).toBe('aggregation');
    expect(stats.suggestions.map((s) => s.label)).not.toContain('host.name');
    const by = labels('FROM logs-* | STATS c = COUNT(*) BY ho');
    expect(by).toContain('host.name');
  });

  it('suggests operators after an operand in WHERE', () => {
    const res = complete({ text: 'FROM logs-* | WHERE bytes ', offset: 26, schema });
    expect(res.context).toBe('operator');
    expect(res.suggestions.map((s) => s.label)).toContain('>=');
  });

  it('completes columns in KEEP without repeating listed ones', () => {
    expect(labels('FROM logs-* | KEEP bytes, ')).not.toContain('bytes');
    expect(labels('FROM logs-* | KEEP bytes, ')).toContain('host.name');
  });

  it('handles ENRICH and LOOKUP JOIN keywords', () => {
    expect(labels('FROM logs-* | ENRICH ')).toContain('geoip');
    expect(labels('FROM logs-* | ENRICH geoip ')).toContain('ON');
    expect(labels('FROM logs-* | LOOKUP JOIN ')).toContain('hosts_lookup');
    expect(labels('FROM logs-* | SORT bytes ')).toContain('DESC');
  });

  it('filters by prefix and places the cursor inside function parentheses', () => {
    const res = complete({ text: 'FROM logs-* | EVAL x = ROU', offset: 26, schema });
    expect(res.suggestions[0].label).toBe('ROUND');
    expect(res.suggestions[0].insertText).toBe('ROUND()');
    expect(res.suggestions[0].cursorDelta).toBe(-1);
    expect(res.replaceStart).toBe(23);
  });

  it('derives the pipeline prefix used for exact column lookups', () => {
    expect(pipelinePrefix('FROM logs-* | STATS c = COUNT(*) BY host.name | WHERE ', 56)).toBe('FROM logs-* | STATS c = COUNT(*) BY host.name');
    expect(pipelinePrefix('FROM lo', 7)).toBeUndefined();
  });
});
