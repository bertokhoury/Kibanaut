import { Box, Text } from 'ink';
import React from 'react';
import { tokenize, type TokenKind } from '../core/tokenize.js';
import type { Diagnostic, Suggestion } from '../core/types.js';
import { displayWidth, formatCell, truncate } from '../render/formats.js';
import type { EsqlResponse } from '../transport/index.js';
import { elastic, KIND_COLORS, KIND_GLYPHS, type Painter, wordmark } from './theme.js';

export interface ConnectionInfo {
  profile: string;
  target: string;
  esVersion?: string;
  demo: boolean;
}

export function Header({ p, info, width, busy }: { p: Painter; info: ConnectionInfo; width: number; busy: boolean }) {
  const left = `${wordmark(p)} ${p.muted('ES|QL mission control')}`;
  const dot = busy ? p.hex(elastic.yellow)('●') : p.hex(elastic.teal)('●');
  const right = `${dot} ${p.c.bold(info.profile)}${p.muted(` · ${info.target}`)}${info.esVersion ? p.muted(` · es ${info.esVersion}`) : ''}${info.demo && info.profile !== 'demo' ? p.hex(elastic.pink)(' · demo') : ''}`;
  const gap = Math.max(1, width - displayWidth(stripAnsi(left)) - displayWidth(stripAnsi(right)));
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        {left}
        {' '.repeat(gap)}
        {right}
      </Text>
    </Box>
  );
}

export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, '');
}

interface StyledRun {
  text: string;
  key: string;
}

/** Paints one editor line: syntax colors, diagnostic underlines, and the cursor cell. */
export function renderEditorLine(line: string, lineOffset: number, cursor: number | undefined, diagnostics: Diagnostic[], p: Painter): string {
  const tokens = tokenize(line);
  const kindAt: TokenKind[] = [];
  for (const t of tokens) for (let i = t.start; i < t.end; i++) kindAt[i] = t.kind;
  const sevAt: Array<Diagnostic['severity'] | undefined> = [];
  for (const d of diagnostics) {
    for (let i = Math.max(0, d.start - lineOffset); i < Math.min(line.length, d.end - lineOffset); i++) {
      if (!sevAt[i] || d.severity === 'error') sevAt[i] = d.severity;
    }
  }
  const chars = [...line, ' '];
  const runs: StyledRun[] = [];
  chars.forEach((ch, i) => {
    const isCursor = cursor !== undefined && lineOffset + i === cursor;
    const key = `${kindAt[i] ?? 'identifier'}|${sevAt[i] ?? ''}|${isCursor ? 'c' : ''}`;
    const last = runs[runs.length - 1];
    if (last && last.key === key) last.text += ch;
    else runs.push({ text: ch, key });
  });
  return runs
    .map((run) => {
      const [kind, sev, cur] = run.key.split('|');
      let painter = p.tok(kind as TokenKind);
      if (sev) painter = (sev === 'error' ? p.sev('error') : sev === 'warning' ? p.sev('warning') : p.sev('info')).underline;
      if (cur) painter = painter.inverse;
      return painter(run.text);
    })
    .join('');
}

export function EditorView({ text, cursor, diagnostics, p, focused, width, height }: { text: string; cursor: number; diagnostics: Diagnostic[]; p: Painter; focused: boolean; width: number; height?: number }) {
  const lines = text.split('\n');
  let offset = 0;
  const rendered = lines.map((line, i) => {
    const painted = renderEditorLine(line, offset, focused ? cursor : undefined, diagnostics, p);
    offset += line.length + 1;
    return (
      <Text key={i}>
        {p.muted(String(i + 1).padStart(3))} {p.hex(elastic.darkShade)('│')} {painted}
      </Text>
    );
  });
  return (
    <Box flexDirection="column" flexShrink={0} borderStyle="round" borderColor={p.border(focused ? elastic.blue : elastic.darkShade)} paddingX={1} width={width} height={height}>
      {rendered}
    </Box>
  );
}

export function CompletionPopup({ items, index, p, marginLeft, maxItems = 8, width }: { items: Suggestion[]; index: number; p: Painter; marginLeft: number; maxItems?: number; width: number }) {
  if (!items.length) return null;
  const inner = Math.max(20, width - marginLeft - 6);
  const start = Math.max(0, Math.min(index - Math.floor(maxItems / 2), items.length - maxItems));
  const visible = items.slice(start, start + maxItems);
  const labelWidth = Math.min(32, Math.max(...visible.map((s) => s.label.length)) + 1);
  return (
    <Box flexDirection="column" flexShrink={0} marginLeft={marginLeft} borderStyle="round" borderColor={p.border(elastic.teal)} paddingX={1}>
      {visible.map((s, i) => {
        const selected = start + i === index;
        const glyph = p.hex(KIND_COLORS[s.kind])(KIND_GLYPHS[s.kind]);
        const label = selected ? p.c.bgHex(elastic.blueDeep).bold(` ${s.label.padEnd(labelWidth)}`) : ` ${s.label.padEnd(labelWidth)}`;
        const detail = s.detail ? p.muted(truncate(s.detail, Math.max(8, inner - labelWidth - 4))) : '';
        return (
          <Text key={s.label} wrap="truncate-end">
            {glyph}
            {label} {detail}
          </Text>
        );
      })}
      {items.length > maxItems ? <Text wrap="truncate-end">{p.muted(`${index + 1}/${items.length} · ↑↓ select · tab/enter accept · esc close`)}</Text> : <Text wrap="truncate-end">{p.muted('tab/enter accept · esc close')}</Text>}
      {items[index]?.documentation ? <Text wrap="truncate-end">{p.hex(elastic.lightShade)(truncate(items[index].documentation.replace(/\s+/g, ' '), inner))}</Text> : null}
    </Box>
  );
}

export function DiagnosticsStrip({ diagnostics, p, max = 3 }: { diagnostics: Diagnostic[]; p: Painter; max?: number }) {
  if (!diagnostics.length) return null;
  const shown = diagnostics.slice(0, max);
  return (
    <Box flexDirection="column" flexShrink={0} paddingX={2}>
      {shown.map((d, i) => (
        <Text key={i} wrap="truncate-end">
          {p.sev(d.severity)(d.severity === 'error' ? '✖' : d.severity === 'warning' ? '▲' : 'ℹ')} {p.muted(`${d.line}:${d.column}`)} {d.message} {p.muted(`[${d.rule}]`)}
        </Text>
      ))}
      {diagnostics.length > max ? <Text wrap="truncate-end">{p.muted(`… ${diagnostics.length - max} more`)}</Text> : null}
    </Box>
  );
}

const NUMERIC_TYPES = new Set(['integer', 'long', 'double', 'unsigned_long', 'float', 'half_float', 'scaled_float', 'counter_long', 'counter_integer', 'counter_double']);

export function computeWidths(res: EsqlResponse, maxWidth: number, maxCell = 40): number[] {
  const widths = res.columns.map((c, i) => Math.max(displayWidth(c.name), displayWidth(c.type), ...res.values.slice(0, 200).map((r) => Math.min(maxCell, displayWidth(formatCell(r[i]))))));
  const gutter = 3;
  const total = () => widths.reduce((a, b) => a + b, 0) + gutter * (widths.length - 1);
  while (total() > maxWidth && Math.max(...widths) > 6) {
    const i = widths.indexOf(Math.max(...widths));
    widths[i] = Math.max(6, widths[i] - Math.min(8, total() - maxWidth));
  }
  return widths;
}

export function ResultsView({ res, scroll, height, width, p, selectedRow, title }: { res: EsqlResponse; scroll: number; height: number; width: number; p: Painter; selectedRow?: number; title?: string }) {
  const inner = Math.max(10, width - 4);
  const widths = React.useMemo(() => computeWidths(res, inner), [res, inner]);
  const pad = (s: string, w: number, right = false) => {
    const fill = ' '.repeat(Math.max(0, w - displayWidth(s)));
    return right ? fill + s : s + fill;
  };
  const header = res.columns.map((c, i) => p.hex(elastic.blue).bold(pad(truncate(c.name, widths[i]), widths[i]))).join('   ');
  const types = res.columns.map((c, i) => p.muted(pad(truncate(c.type, widths[i]), widths[i]))).join('   ');
  const rule = p.hex(elastic.darkShade)(widths.map((w) => '─'.repeat(w)).join('───'));
  const bodyHeight = Math.max(1, height - 6);
  const rows = res.values.slice(scroll, scroll + bodyHeight).map((row, r) => {
    const idx = scroll + r;
    const cells = row
      .map((v, i) => {
        const numeric = NUMERIC_TYPES.has(res.columns[i].type);
        const text = formatCell(v).replace(/\s+/g, ' ');
        if (text === '') return p.hex(elastic.darkShade)(pad('null', widths[i], numeric));
        const cell = pad(truncate(text, widths[i]), widths[i], numeric);
        return numeric ? p.hex(elastic.yellow)(cell) : cell;
      })
      .join('   ');
    return (
      <Text key={idx} wrap="truncate-end">
        {selectedRow === idx ? p.c.bgHex(elastic.dark)(stripAnsi(cells)) : cells}
      </Text>
    );
  });
  const footer = `${res.values.length} row${res.values.length === 1 ? '' : 's'}${res.took !== undefined ? ` · ${res.took} ms` : ''}${res.values.length > bodyHeight ? ` · showing ${scroll + 1}-${Math.min(res.values.length, scroll + bodyHeight)} (pgup/pgdn)` : ''}`;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={p.border(elastic.darkShade)} paddingX={1} width={width} height={height} overflow="hidden">
      {title ? <Text wrap="truncate-end">{p.hex(elastic.teal).bold(title)}</Text> : null}
      <Text wrap="truncate-end">{header}</Text>
      <Text wrap="truncate-end">{types}</Text>
      <Text wrap="truncate-end">{rule}</Text>
      {rows}
      <Text wrap="truncate-end">{p.muted(footer)}</Text>
    </Box>
  );
}

export function RecordView({ res, row, height, width, p }: { res: EsqlResponse; row: number; height: number; width: number; p: Painter }) {
  const values = res.values[row] ?? [];
  const keyWidth = Math.min(36, Math.max(...res.columns.map((c) => c.name.length)));
  const lines = res.columns.slice(0, Math.max(1, height - 4)).map((c, i) => (
    <Text key={c.name} wrap="truncate-end">
      {p.hex(elastic.blue)(c.name.padEnd(keyWidth))} {p.muted(c.type.padEnd(10))} {truncate(formatCell(values[i]), Math.max(10, width - keyWidth - 18))}
    </Text>
  ));
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={p.border(elastic.darkShade)} paddingX={1} width={width} height={height} overflow="hidden">
      <Text wrap="truncate-end">{p.hex(elastic.teal).bold(`record ${row + 1} of ${res.values.length}`)} {p.muted('↑↓ move · ^x back to table')}</Text>
      {lines}
    </Box>
  );
}

export function HelpView({ p, width, height }: { p: Painter; width: number; height: number }) {
  const k = (key: string, desc: string) => (
    <Text key={key} wrap="truncate-end">
      {p.hex(elastic.yellow)(key.padEnd(14))} {desc}
    </Text>
  );
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={p.border(elastic.teal)} paddingX={1} width={width} height={height} overflow="hidden">
      <Text>{p.hex(elastic.teal).bold('keys')}</Text>
      {k('enter', 'run the query (inserts a newline while the query is incomplete)')}
      {k('alt+enter', 'insert a newline')}
      {k('tab', 'open completion / accept the highlighted suggestion')}
      {k('|', 'starts a new piped command on its own line')}
      {k('↑ ↓', 'move between lines; at the edges, walk the query history')}
      {k('pgup pgdn', 'scroll results')}
      {k('^f', 'format the query')}
      {k('^x', 'toggle record view for the selected row')}
      {k('^o', 'show an open-in-Discover link')}
      {k('^s', 'save the query to a .esql file')}
      {k('^e', 'export results to CSV')}
      {k('^u', 'clear the editor')}
      {k('^q', 'quit')}
      <Text> </Text>
      <Text>{p.hex(elastic.teal).bold('meta commands')} {p.muted('(type in the editor, then enter)')}</Text>
      {k('\\i [pattern]', 'list indices, aliases, and data streams')}
      {k('\\d <index>', 'list fields of an index pattern')}
      {k('\\p', 'list enrich policies')}
      {k('\\x', 'toggle record view')}
      {k('\\c', 'clear results')}
      {k('\\h', 'toggle this help')}
      {k('\\q', 'quit')}
    </Box>
  );
}

export function StatusBar({ p, left, right, width }: { p: Painter; left: string; right: string; width: number }) {
  const gap = Math.max(1, width - displayWidth(stripAnsi(left)) - displayWidth(stripAnsi(right)));
  return (
    <Box flexShrink={0}>
      <Text wrap="truncate-end">
        {left}
        {' '.repeat(gap)}
        {right}
      </Text>
    </Box>
  );
}
