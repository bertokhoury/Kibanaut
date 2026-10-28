import { parseQuery, type ParsedQuery } from '../ast.js';
import { computeColumnFlow, type ColumnFlow } from '../columns.js';
import { indexLines, offsetToPosition, type Diagnostic, type Field, type Severity } from '../types.js';
import { RULES, RULE_BY_CODE, RULE_BY_NAME } from './rules.js';

export type SeveritySetting = Severity | 'off';

export interface LintConfig {
  rules?: Record<string, SeveritySetting>;
  functionCase?: 'upper' | 'lower' | 'ignore';
}

export interface LintOptions {
  /** Fields of the FROM/TS sources; enables unknown-column and type checks. */
  fields?: Field[];
  config?: LintConfig;
}

export interface LintResult {
  diagnostics: Diagnostic[];
  parsed: ParsedQuery;
  flow: ColumnFlow;
  errorCount: number;
  warningCount: number;
}

export const DEFAULT_CONFIG: Required<LintConfig> = {
  rules: {},
  functionCase: 'upper',
};

function resolveSeverity(ruleName: string, code: string, config: LintConfig): SeveritySetting {
  const rule = RULE_BY_NAME.get(ruleName) ?? RULE_BY_CODE.get(code);
  const override = config.rules?.[ruleName] ?? config.rules?.[code];
  return override ?? rule?.meta.severity ?? 'warning';
}

/** Lines disabled through `// kibanaut-disable-next-line [rule]` or `// kibanaut-disable-line [rule]`. */
function disabledLines(text: string): Map<number, Set<string> | 'all'> {
  const out = new Map<number, Set<string> | 'all'>();
  const lines = text.split('\n');
  lines.forEach((line, idx) => {
    const m = /\/\/\s*kibanaut-disable-(next-line|line)\s*([A-Za-z0-9_,\s-]*)/.exec(line);
    if (!m) return;
    const target = m[1] === 'next-line' ? idx + 2 : idx + 1;
    const names = m[2].split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const existing = out.get(target);
    if (!names.length) out.set(target, 'all');
    else if (existing !== 'all') out.set(target, new Set([...(existing ?? []), ...names]));
  });
  return out;
}

export function lintQuery(text: string, options: LintOptions = {}): LintResult {
  const config = { ...DEFAULT_CONFIG, ...options.config };
  const parsed = parseQuery(text);
  const flow = computeColumnFlow(parsed.commands, options.fields);
  const lines = indexLines(text);
  const disabled = disabledLines(text);
  const diagnostics: Diagnostic[] = [...parsed.syntaxErrors];

  // Semantic rules are noisy on top of syntax errors; keep style/perf rules only.
  const skipSemantic = parsed.syntaxErrors.length > 0;

  for (const rule of RULES) {
    const severity = resolveSeverity(rule.meta.name, rule.meta.code, config);
    if (severity === 'off') continue;
    if (skipSemantic && rule.meta.code.startsWith('E')) continue;
    let raws;
    try {
      raws = rule.run({ parsed, flow, hasSchema: Boolean(options.fields), functionCase: config.functionCase });
    } catch {
      continue;
    }
    for (const raw of raws) {
      const pos = offsetToPosition(lines, raw.start);
      diagnostics.push({
        code: rule.meta.code,
        rule: rule.meta.name,
        severity: raw.severity ?? severity,
        message: raw.message,
        start: raw.start,
        end: raw.end,
        line: pos.line,
        column: pos.column,
        fixable: rule.meta.fixable,
      });
    }
  }

  const filtered = diagnostics.filter((d) => {
    const entry = disabled.get(d.line);
    if (!entry) return true;
    if (entry === 'all') return false;
    return !(entry.has(d.rule) || entry.has(d.code));
  });

  filtered.sort((a, b) => a.start - b.start || severityRank(a.severity) - severityRank(b.severity));
  return {
    diagnostics: filtered,
    parsed,
    flow,
    errorCount: filtered.filter((d) => d.severity === 'error').length,
    warningCount: filtered.filter((d) => d.severity === 'warning').length,
  };
}

export function severityRank(s: Severity): number {
  return s === 'error' ? 0 : s === 'warning' ? 1 : 2;
}

export { RULES } from './rules.js';
