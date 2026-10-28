import chalk, { Chalk, type ChalkInstance } from 'chalk';

/**
 * Elastic brand palette (logo colors + EUI shades). Every color used by the
 * TUI and the CLI output is a token here so the look can be re-rooted in one place.
 */
export const elastic = {
  yellow: '#FEC514',
  teal: '#00BFB3',
  pink: '#F04E98',
  blue: '#1BA9F5',
  blueDeep: '#0B64DD',
  ink: '#1A1C21',
  dark: '#343741',
  darkShade: '#69707D',
  mediumShade: '#98A2B3',
  lightShade: '#D3DAE6',
  // EUI dark-mode text variants so states stay readable on dark terminals.
  danger: '#F86B63',
  warning: '#F3D371',
  success: '#7DDED8',
  text: '#DFE5EF',
} as const;

export type ElasticColor = keyof typeof elastic;

/** The four logo stripes, used for the wordmark and as the brand accent order. */
export const LOGO_STRIPES: ElasticColor[] = ['yellow', 'teal', 'pink', 'blue'];

export const TOKEN_COLORS = {
  command: elastic.blue,
  keyword: elastic.blue,
  function: elastic.teal,
  identifier: elastic.text,
  string: elastic.yellow,
  number: elastic.yellow,
  param: elastic.pink,
  pipe: elastic.pink,
  operator: elastic.pink,
  punct: elastic.lightShade,
  comment: elastic.mediumShade,
  whitespace: elastic.text,
  unknown: elastic.danger,
} as const;

export const SEVERITY_COLORS = {
  error: elastic.danger,
  warning: elastic.warning,
  info: elastic.mediumShade,
} as const;

export const KIND_COLORS = {
  command: elastic.blue,
  keyword: elastic.blue,
  function: elastic.teal,
  aggregation: elastic.teal,
  column: elastic.text,
  source: elastic.yellow,
  policy: elastic.yellow,
  lookup: elastic.yellow,
  value: elastic.yellow,
  operator: elastic.pink,
} as const;

export const KIND_GLYPHS: Record<keyof typeof KIND_COLORS, string> = {
  command: '▸',
  keyword: '·',
  function: 'ƒ',
  aggregation: '∑',
  column: '≡',
  source: '◫',
  policy: '◈',
  lookup: '⇄',
  value: '#',
  operator: '±',
};

/** Named fallbacks for terminals without truecolor, so borders never map to black. */
const BORDER_FALLBACK: Record<string, string> = {
  [elastic.blue]: 'cyan',
  [elastic.teal]: 'cyan',
  [elastic.darkShade]: 'gray',
  [elastic.mediumShade]: 'gray',
  [elastic.pink]: 'magenta',
  [elastic.yellow]: 'yellow',
};

export interface Painter {
  c: ChalkInstance;
  /** Color string for Ink `borderColor`: the hex on truecolor terminals, a named color otherwise. */
  border(hex: string): string;
  hex(color: string): ChalkInstance;
  tok(kind: keyof typeof TOKEN_COLORS): ChalkInstance;
  sev(severity: keyof typeof SEVERITY_COLORS): ChalkInstance;
  brand: ChalkInstance;
  muted: ChalkInstance;
  accent: ChalkInstance;
  ok: ChalkInstance;
  warn: ChalkInstance;
  err: ChalkInstance;
  enabled: boolean;
}

export function createPainter(options: { color?: boolean; level?: 0 | 1 | 2 | 3 } = {}): Painter {
  const level = options.color === false ? 0 : options.level ?? (process.env.FORCE_COLOR ? 3 : chalk.level);
  const c = new Chalk({ level });
  const hex = (color: string) => c.hex(color);
  return {
    c,
    border: (color) => (level >= 3 ? color : BORDER_FALLBACK[color] ?? 'gray'),
    hex,
    tok: (kind) => (kind === 'command' ? hex(TOKEN_COLORS[kind]).bold : kind === 'comment' ? hex(TOKEN_COLORS[kind]).italic : hex(TOKEN_COLORS[kind])),
    sev: (severity) => hex(SEVERITY_COLORS[severity]),
    brand: hex(elastic.blue).bold,
    muted: hex(elastic.mediumShade),
    accent: hex(elastic.teal),
    ok: hex(elastic.success),
    warn: hex(elastic.warning),
    err: hex(elastic.danger),
    enabled: level > 0,
  };
}

/** `kibanaut` wordmark preceded by the four Elastic stripes. */
export function wordmark(p: Painter, text = 'kibanaut'): string {
  const stripes = LOGO_STRIPES.map((name) => p.hex(elastic[name])('▍')).join('');
  return `${stripes} ${p.c.bold(text)}`;
}
