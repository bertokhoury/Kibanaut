import { describe, expect, it } from 'vitest';
import { lintQuery } from '../src/core/lint/index.js';
import type { Field } from '../src/core/types.js';

const FIELDS: Field[] = [
  { name: '@timestamp', type: 'date' },
  { name: 'host.name', type: 'keyword' },
  { name: 'bytes', type: 'long' },
  { name: 'status', type: 'integer' },
];

const codes = (text: string, fields?: Field[]) => lintQuery(text, { fields }).diagnostics.map((d) => d.code);

describe('lint', () => {
  it('reports syntax errors with positions', () => {
    const { diagnostics } = lintQuery('FROM logs-* | WHERE status >= | LIMIT 10');
    const syntax = diagnostics.find((d) => d.code === 'E001');
    expect(syntax?.line).toBe(1);
    expect(syntax?.column).toBeGreaterThan(20);
    expect(diagnostics.map((d) => d.code)).not.toContain('E005');
  });

  it('flags unknown columns with a did-you-mean hint when the schema is known', () => {
    const { diagnostics } = lintQuery('FROM logs-* | WHERE hostname == "a" | LIMIT 10', { fields: FIELDS });
    const unknown = diagnostics.find((d) => d.code === 'E005');
    expect(unknown?.message).toContain('did you mean host.name');
  });

  it('tracks columns through STATS and KEEP', () => {
    expect(codes('FROM logs-* | STATS c = COUNT(*) BY host.name | KEEP c, host.name | LIMIT 5', FIELDS)).not.toContain('E005');
    expect(codes('FROM logs-* | STATS c = COUNT(*) BY host.name | KEEP bytes | LIMIT 5', FIELDS)).toContain('E005');
    expect(codes('FROM logs-* | RENAME bytes AS b | KEEP b | LIMIT 5', FIELDS)).not.toContain('E005');
  });

  it('knows DISSECT and GROK add columns', () => {
    expect(codes('FROM logs-* | DISSECT host.name "%{a}-%{b}" | KEEP a, b | LIMIT 5', FIELDS)).not.toContain('E005');
    expect(codes('FROM logs-* | GROK host.name "%{WORD:w}" | KEEP w | LIMIT 5', FIELDS)).not.toContain('E005');
  });

  it('warns about missing and unbounded LIMITs', () => {
    expect(codes('FROM logs-* | WHERE status > 1')).toContain('W101');
    expect(codes('FROM logs-* | SORT status | LIMIT 5')).not.toContain('W102');
    expect(codes('FROM logs-* | SORT status')).toContain('W102');
    expect(codes('FROM logs-* | STATS c = COUNT(*)')).not.toContain('W101');
  });

  it('finds EVAL columns that never reach the output', () => {
    expect(codes('FROM logs-* | EVAL kb = bytes / 1024 | STATS c = COUNT(*) BY host.name | LIMIT 5', FIELDS)).toContain('W103');
    expect(codes('FROM logs-* | EVAL kb = bytes / 1024 | STATS m = MAX(kb) BY host.name | LIMIT 5', FIELDS)).not.toContain('W103');
    expect(codes('FROM logs-* | EVAL kb = bytes / 1024 | LIMIT 5', FIELDS)).not.toContain('W103');
  });

  it('rejects aggregations outside STATS and nested aggregations', () => {
    expect(codes('FROM logs-* | EVAL c = COUNT(*) | LIMIT 5', FIELDS)).toContain('E006');
    expect(codes('FROM logs-* | STATS m = MAX(AVG(bytes)) | LIMIT 5', FIELDS)).toContain('E007');
  });

  it('checks arity and argument types from the signatures', () => {
    expect(codes('FROM logs-* | EVAL d = DATE_TRUNC(@timestamp) | LIMIT 5', FIELDS)).toContain('E003');
    expect(codes('FROM logs-* | EVAL d = DATE_TRUNC("day", @timestamp) | LIMIT 5', FIELDS)).toContain('E004');
    expect(codes('FROM logs-* | EVAL d = DATE_TRUNC(1 day, @timestamp) | LIMIT 5', FIELDS)).not.toContain('E004');
    expect(codes('FROM logs-* | EVAL d = NOT_A_FUNCTION(1) | LIMIT 5', FIELDS)).toContain('E002');
  });

  it('suggests moving group-key filters before STATS', () => {
    expect(codes('FROM logs-* | STATS c = COUNT(*) BY host.name | WHERE host.name == "a" | LIMIT 5', FIELDS)).toContain('W104');
    expect(codes('FROM logs-* | STATS c = COUNT(*) BY host.name | WHERE c > 10 | LIMIT 5', FIELDS)).not.toContain('W104');
  });

  it('reports style hints once per line and honours disable comments', () => {
    const style = lintQuery('from logs-* | where status > 1 | limit 5').diagnostics.filter((d) => d.code === 'S201');
    expect(style).toHaveLength(1);
    expect(style[0].message).toContain('FROM, WHERE, LIMIT');
    const disabled = lintQuery('// kibanaut-disable-next-line no-implicit-limit\nFROM logs-* | WHERE status > 1');
    expect(disabled.diagnostics.map((d) => d.code)).not.toContain('W101');
  });

  it('respects rule severity overrides', () => {
    const res = lintQuery('FROM logs-* | WHERE status > 1', { config: { rules: { 'no-implicit-limit': 'error', 'one-command-per-line': 'off' } } });
    expect(res.errorCount).toBe(1);
    expect(res.diagnostics.map((d) => d.code)).not.toContain('S202');
  });
});
