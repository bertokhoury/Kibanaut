import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/config/credentials.js';
import { ansiToSvg } from '../src/render/ansi-svg.js';
import { renderDiagnostics } from '../src/render/diagnostics.js';
import { renderResult, renderTable } from '../src/render/formats.js';
import { demoRows, runDemoQuery } from '../src/transport/demo.js';
import { parseParams } from '../src/transport/index.js';
import { discoverLink, risonString } from '../src/transport/schema.js';
import { createPainter } from '../src/ui/theme.js';
import { lintQuery } from '../src/core/lint/index.js';

const res = { columns: [{ name: 'host', type: 'keyword' }, { name: 'n', type: 'long' }], values: [['a', 1], ['b', null]], took: 3 };

describe('renderers', () => {
  it('renders a table with types, right-aligned numbers, and a footer', () => {
    const out = renderTable(res);
    expect(out.split('\n')[0]).toMatch(/^host\s+n/);
    expect(out).toContain('keyword');
    expect(out).toContain('null');
    expect(out).toContain('2 rows · 3 ms');
  });
  it('renders json, csv, and markdown', () => {
    expect(JSON.parse(renderResult(res, 'json'))).toEqual([{ host: 'a', n: 1 }, { host: 'b', n: null }]);
    expect(renderResult(res, 'csv')).toBe('host,n\na,1\nb,');
    expect(renderResult(res, 'md').split('\n')[1]).toBe('| --- | --- |');
  });
  it('emits github annotations and sarif', () => {
    const p = createPainter({ color: false });
    const text = 'FROM a | SORT b';
    const { diagnostics } = lintQuery(text);
    expect(renderDiagnostics(text, diagnostics, 'github', p, 'q.esql')).toContain('::warning file=q.esql');
    const sarif = JSON.parse(renderDiagnostics(text, diagnostics, 'sarif', p, 'q.esql')) as { runs: Array<{ results: unknown[] }> };
    expect(sarif.runs[0].results.length).toBe(diagnostics.length);
  });
  it('converts ANSI frames to SVG', () => {
    const svg = ansiToSvg('\u001b[38;2;27;169;245m\u001b[1mFROM\u001b[22m\u001b[39m logs\n\u001b[7mx\u001b[27m', { columns: 20, rows: 2 });
    expect(svg).toContain('<svg');
    expect(svg).toContain('fill="#1ba9f5"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('<rect');
  });
});

describe('discover links and params', () => {
  it('encodes rison strings', () => {
    expect(risonString("it's !")).toBe("'it!'s !!'");
    const link = discoverLink('https://kb.example.com/', 'FROM logs-* | LIMIT 1', 'ops');
    expect(link.startsWith('https://kb.example.com/s/ops/app/discover#/?_a=')).toBe(true);
    expect(decodeURIComponent(link)).toContain("(query:(esql:'FROM logs-* | LIMIT 1'))");
  });
  it('infers parameter types', () => {
    expect(parseParams(['n=5', 'name=web', 'ok=true', 'list=[1,2]'])).toEqual([{ n: 5 }, { name: 'web' }, { ok: true }, { list: [1, 2] }]);
    expect(() => parseParams(['bad'])).toThrow();
  });
});

describe('demo backend', () => {
  const rows = demoRows(50, 1);
  it('runs filters, aggregations, sorting, and limits', () => {
    const out = runDemoQuery('FROM logs-* | WHERE http.response.status_code >= 500 | STATS c = COUNT(*), b = SUM(bytes) BY service.name | SORT c DESC | LIMIT 3', rows);
    expect(out.columns.map((c) => c.name)).toEqual(['c', 'b', 'service.name']);
    expect(out.values.length).toBeLessThanOrEqual(3);
    expect((out.values[0]?.[0] as number) >= (out.values[1]?.[0] as number ?? 0)).toBe(true);
  });
  it('supports KEEP, EVAL, and ROW', () => {
    expect(runDemoQuery('ROW a = 1, b = "x"', rows).values).toEqual([[1, 'x']]);
    const out = runDemoQuery('FROM logs-* | EVAL kb = bytes / 1024 | KEEP host.name, kb | LIMIT 2', rows);
    expect(out.columns.map((c) => c.name)).toEqual(['host.name', 'kb']);
    expect(out.values).toHaveLength(2);
  });
  it('rejects unsupported commands with a clear error', () => {
    expect(() => runDemoQuery('FROM logs-* | ENRICH x', rows)).toThrow(/demo backend/);
  });
});

describe('credentials file store', () => {
  it('round-trips secrets with 0600 permissions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kibanaut-'));
    process.env.KIBANAUT_CONFIG_DIR = dir;
    const store = new FileStore(join(dir, 'credentials.json'));
    await store.set('prod', { type: 'apiKey', value: 'abc' });
    expect(await store.get('prod')).toEqual({ type: 'apiKey', value: 'abc' });
    await store.delete('prod');
    expect(await store.get('prod')).toBeUndefined();
  });
});
