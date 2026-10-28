import type { EsqlResponse } from '../transport/index.js';
import { elastic, type Painter } from '../ui/theme.js';

export type OutputFormat = 'table' | 'json' | 'ndjson' | 'csv' | 'tsv' | 'md';
export const OUTPUT_FORMATS: OutputFormat[] = ['table', 'json', 'ndjson', 'csv', 'tsv', 'md'];

export function formatCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

/** Display width of a string, treating wide characters as 2 columns. */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) continue;
    w += cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1faff)) ? 2 : 1;
  }
  return w;
}

export function truncate(s: string, max: number): string {
  if (max <= 1) return s.slice(0, Math.max(0, max));
  if (displayWidth(s) <= max) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = displayWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

const pad = (s: string, width: number, right = false) => {
  const fill = ' '.repeat(Math.max(0, width - displayWidth(s)));
  return right ? fill + s : s + fill;
};

const NUMERIC_TYPES = new Set(['integer', 'long', 'double', 'unsigned_long', 'float', 'half_float', 'scaled_float', 'counter_long', 'counter_integer', 'counter_double']);

export interface TableOptions {
  maxWidth?: number;
  maxCellWidth?: number;
  painter?: Painter;
  /** Omit the footer line (row count / took). */
  noFooter?: boolean;
}

export function renderTable(res: EsqlResponse, options: TableOptions = {}): string {
  const { columns, values } = res;
  if (!columns.length) return options.painter ? options.painter.muted('(no columns)') : '(no columns)';
  const p = options.painter;
  const maxCell = options.maxCellWidth ?? 48;
  const cells = values.map((row) => row.map((v) => truncate(formatCell(v).replace(/\s+/g, ' '), maxCell)));
  let widths = columns.map((c, i) => Math.max(displayWidth(c.name), displayWidth(c.type), ...cells.map((r) => (r[i] === '' ? 4 : displayWidth(r[i] ?? '')))));

  // Shrink the widest columns until the table fits the terminal.
  const sep = 3;
  const available = options.maxWidth ?? Number.POSITIVE_INFINITY;
  const total = () => widths.reduce((a, b) => a + b, 0) + sep * (widths.length - 1);
  while (total() > available && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths));
    widths[i] = Math.max(6, widths[i] - Math.min(8, Math.ceil((total() - available) / 2)));
  }
  widths = widths.map((w) => Math.max(w, 1));

  const paintHeader = (s: string) => (p ? p.hex(elastic.blue).bold(s) : s);
  const paintRule = (s: string) => (p ? p.hex(elastic.darkShade)(s) : s);
  const paintType = (s: string) => (p ? p.muted(s) : s);
  const paintNull = (s: string) => (p ? p.hex(elastic.darkShade)(s) : s);
  const paintNumber = (s: string) => (p ? p.hex(elastic.yellow)(s) : s);
  const gutter = '   ';

  const header = columns.map((c, i) => paintHeader(pad(truncate(c.name, widths[i]), widths[i]))).join(gutter);
  const types = columns.map((c, i) => paintType(pad(truncate(c.type, widths[i]), widths[i]))).join(gutter);
  const rule = paintRule(widths.map((w) => '─'.repeat(w)).join('─┼─'.replace('┼', '┼')));
  const body = cells.map((row) =>
    row
      .map((cell, i) => {
        const numeric = NUMERIC_TYPES.has(columns[i].type);
        const text = pad(truncate(cell, widths[i]), widths[i], numeric);
        if (cell === '') return paintNull(pad('null', widths[i], numeric));
        return numeric ? paintNumber(text) : text;
      })
      .join(gutter),
  );
  const lines = [header, types, rule, ...body];
  if (!options.noFooter) {
    const footer = `${values.length} row${values.length === 1 ? '' : 's'}${res.took !== undefined ? ` · ${res.took} ms` : ''}${res.is_partial ? ' · partial' : ''}`;
    lines.push(p ? p.muted(footer) : footer);
  }
  return lines.join('\n');
}

function csvEscape(s: string, delimiter: string): string {
  return /[\n"]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderResult(res: EsqlResponse, format: OutputFormat, options: TableOptions = {}): string {
  switch (format) {
    case 'json':
      return JSON.stringify(res.values.map((row) => Object.fromEntries(row.map((v, i) => [res.columns[i].name, v]))), null, 2);
    case 'ndjson':
      return res.values.map((row) => JSON.stringify(Object.fromEntries(row.map((v, i) => [res.columns[i].name, v])))).join('\n');
    case 'csv':
    case 'tsv': {
      const d = format === 'csv' ? ',' : '\t';
      return [res.columns.map((c) => csvEscape(c.name, d)).join(d), ...res.values.map((row) => row.map((v) => csvEscape(formatCell(v), d)).join(d))].join('\n');
    }
    case 'md': {
      const head = `| ${res.columns.map((c) => c.name).join(' | ')} |`;
      const sep = `| ${res.columns.map(() => '---').join(' | ')} |`;
      const rows = res.values.map((row) => `| ${row.map((v) => formatCell(v).replace(/\|/g, '\\|')).join(' | ')} |`);
      return [head, sep, ...rows].join('\n');
    }
    default:
      return renderTable(res, options);
  }
}
