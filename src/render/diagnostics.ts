import { tokenize } from '../core/tokenize.js';
import type { Diagnostic } from '../core/types.js';
import type { Painter } from '../ui/theme.js';

export type LintFormat = 'text' | 'json' | 'sarif' | 'github';

export function highlightLine(line: string, p: Painter): string {
  return tokenize(line)
    .map((t) => (t.kind === 'whitespace' ? t.text : p.tok(t.kind)(t.text)))
    .join('');
}

/** Renders diagnostics as `file:line:col` code frames with carets under the offending span. */
export function renderCodeFrames(text: string, diagnostics: Diagnostic[], p: Painter, file = '<query>'): string {
  if (!diagnostics.length) return p.ok('✔ no problems');
  const lines = text.split('\n');
  const out: string[] = [];
  for (const d of diagnostics) {
    const line = lines[d.line - 1] ?? '';
    const sev = p.sev(d.severity);
    const label = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info';
    out.push(`${p.c.bold(`${file}:${d.line}:${d.column}`)} ${sev(label)} ${d.message} ${p.muted(`[${d.rule}]`)}${d.fixable ? p.muted(' (fixable)') : ''}`);
    const gutter = p.muted(String(d.line).padStart(4) + ' │ ');
    out.push(`${gutter}${highlightLine(line, p)}`);
    const lineStart = lines.slice(0, d.line - 1).reduce((acc, l) => acc + l.length + 1, 0);
    const from = Math.max(0, d.start - lineStart);
    const to = Math.max(from + 1, Math.min(line.length || from + 1, d.end - lineStart));
    out.push(`${' '.repeat(7)}${' '.repeat(from)}${sev('^'.repeat(to - from))}`);
    out.push('');
  }
  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const infos = diagnostics.length - errors - warnings;
  const summary = [errors && p.err(`${errors} error${errors === 1 ? '' : 's'}`), warnings && p.warn(`${warnings} warning${warnings === 1 ? '' : 's'}`), infos && p.muted(`${infos} hint${infos === 1 ? '' : 's'}`)].filter(Boolean).join(', ');
  out.push(summary);
  return out.join('\n');
}

export function renderDiagnostics(text: string, diagnostics: Diagnostic[], format: LintFormat, p: Painter, file = '<query>'): string {
  switch (format) {
    case 'json':
      return JSON.stringify({ file, diagnostics }, null, 2);
    case 'github':
      return diagnostics
        .map((d) => {
          const level = d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'notice';
          return `::${level} file=${file},line=${d.line},col=${d.column},title=${d.rule}::${d.message}`;
        })
        .join('\n');
    case 'sarif':
      return JSON.stringify(toSarif([{ file, diagnostics }]), null, 2);
    default:
      return renderCodeFrames(text, diagnostics, p, file);
  }
}

export function toSarif(files: Array<{ file: string; diagnostics: Diagnostic[] }>): unknown {
  const rules = new Map<string, { id: string; name: string }>();
  const results = files.flatMap(({ file, diagnostics }) =>
    diagnostics.map((d) => {
      rules.set(d.code, { id: d.code, name: d.rule });
      return {
        ruleId: d.code,
        level: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'note',
        message: { text: d.message },
        locations: [{ physicalLocation: { artifactLocation: { uri: file }, region: { startLine: d.line, startColumn: d.column } } }],
      };
    }),
  );
  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'kibanaut', informationUri: 'https://github.com/albertkhoury-elasticgov/Kibanaut', rules: [...rules.values()] } }, results }],
  };
}
