import { BasicPrettyPrinter, WrappingPrettyPrinter } from '@elastic/esql';
import { parseQuery } from './ast.js';

export interface FormatOptions {
  /** Wrap long commands at this column (0 disables wrapping). */
  wrap?: number;
  /** Indentation placed before each `|`. */
  pipeTab?: string;
  functionCase?: 'upper' | 'lower' | 'ignore';
  /** Keep single-line output. */
  inline?: boolean;
}

export interface FormatResult {
  text: string;
  changed: boolean;
  /** Set when the query has syntax errors; the input is returned untouched. */
  error?: string;
}

export function formatQuery(text: string, options: FormatOptions = {}): FormatResult {
  const parsed = parseQuery(text);
  if (parsed.syntaxErrors.length) {
    return { text, changed: false, error: parsed.syntaxErrors[0].message };
  }
  const lowercaseFunctions = options.functionCase === 'lower';
  let out: string;
  if (options.inline) {
    out = BasicPrettyPrinter.print(parsed.root, { lowercaseFunctions });
  } else if (options.wrap && options.wrap > 0) {
    out = WrappingPrettyPrinter.print(parsed.root, { wrap: options.wrap, pipeTab: options.pipeTab ?? '  ', lowercaseFunctions });
  } else {
    out = BasicPrettyPrinter.multiline(parsed.root, { pipeTab: options.pipeTab ?? '  ', lowercaseFunctions });
  }
  const trimmedInput = text.trim();
  return { text: out, changed: out !== trimmedInput };
}
