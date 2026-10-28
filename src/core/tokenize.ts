import { ALL_COMMAND_NAMES, ALL_FUNCTION_NAMES, BINARY_OPERATOR_KEYWORDS, LITERAL_KEYWORDS, OPTION_KEYWORDS, SORT_MODIFIERS, UNARY_OPERATOR_KEYWORDS } from '../definitions/index.js';

export type TokenKind =
  | 'command'
  | 'keyword'
  | 'function'
  | 'identifier'
  | 'string'
  | 'number'
  | 'param'
  | 'pipe'
  | 'operator'
  | 'punct'
  | 'comment'
  | 'whitespace'
  | 'unknown';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

const COMMAND_WORDS = new Set<string>();
for (const name of ALL_COMMAND_NAMES) for (const w of name.split(' ')) COMMAND_WORDS.add(w.toUpperCase());
COMMAND_WORDS.add('INLINE');

const KEYWORDS = new Set<string>([
  ...BINARY_OPERATOR_KEYWORDS,
  ...UNARY_OPERATOR_KEYWORDS,
  ...SORT_MODIFIERS,
  ...LITERAL_KEYWORDS,
  ...OPTION_KEYWORDS,
  'AS',
  'NOT',
  'INFO',
  'APPEND_SEPARATOR',
].map((k) => k.toUpperCase()));

const FUNCTIONS = new Set(ALL_FUNCTION_NAMES.map((f) => f.toUpperCase()));

const TIME_UNITS = /^(millisecond|milliseconds|ms|second|seconds|sec|s|minute|minutes|min|hour|hours|h|day|days|d|week|weeks|w|month|months|mo|quarter|quarters|q|year|years|yr|y)$/i;

const RULES: Array<[TokenKind, RegExp]> = [
  ['whitespace', /^\s+/],
  ['comment', /^\/\/[^\n]*/],
  ['comment', /^\/\*[\s\S]*?(?:\*\/|$)/],
  ['string', /^"""[\s\S]*?(?:"""|$)/],
  ['string', /^"(?:[^"\\]|\\.)*(?:"|$)/],
  ['param', /^\?\??[A-Za-z_][A-Za-z0-9_]*|^\?\d+|^\?/],
  ['number', /^(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/],
  ['pipe', /^\|/],
  ['operator', /^(?:==|!=|<=|>=|=~|::|[<>=+\-*/%:])/],
  ['punct', /^[(),\[\]{}.;]/],
  ['identifier', /^`(?:[^`]|``)*`/],
  ['identifier', /^[@A-Za-z_][A-Za-z0-9_*.\-@]*/],
];

export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let pos = 0;
  let prevSignificant: Token | undefined;
  let atCommandStart = true;

  while (pos < text.length) {
    const rest = text.slice(pos);
    let matched = false;
    for (const [kind, re] of RULES) {
      const m = re.exec(rest);
      if (!m || m[0].length === 0) continue;
      let resolved: TokenKind = kind;
      const word = m[0];
      const upper = word.toUpperCase();

      if (kind === 'identifier' && !word.startsWith('`')) {
        const next = rest.slice(word.length);
        const callFollows = /^\s*\(/.test(next);
        if (atCommandStart && COMMAND_WORDS.has(upper)) resolved = 'command';
        else if (prevSignificant?.kind === 'command' && COMMAND_WORDS.has(upper) && /^(STATS|JOIN)$/.test(upper)) resolved = 'command';
        else if (callFollows && FUNCTIONS.has(upper)) resolved = 'function';
        else if (KEYWORDS.has(upper) && !callFollows) resolved = 'keyword';
        else if (prevSignificant?.kind === 'number' && TIME_UNITS.test(word)) resolved = 'keyword';
        else resolved = 'identifier';
      }

      const token: Token = { kind: resolved, text: word, start: pos, end: pos + word.length };
      tokens.push(token);
      pos += word.length;
      if (resolved !== 'whitespace' && resolved !== 'comment') {
        if (resolved === 'pipe') atCommandStart = true;
        else if (resolved === 'command') atCommandStart = /^(INLINE|LOOKUP|LEFT|RIGHT)$/.test(upper);
        else atCommandStart = false;
        prevSignificant = token;
      }
      matched = true;
      break;
    }
    if (!matched) {
      tokens.push({ kind: 'unknown', text: text[pos], start: pos, end: pos + 1 });
      pos += 1;
      atCommandStart = false;
    }
  }
  return tokens;
}

/** The identifier-ish word immediately before `offset` (for completion prefixes). */
export function wordBefore(text: string, offset: number): { word: string; start: number } {
  let start = offset;
  while (start > 0 && /[@A-Za-z0-9_.*\-]/.test(text[start - 1])) start--;
  return { word: text.slice(start, offset), start };
}
