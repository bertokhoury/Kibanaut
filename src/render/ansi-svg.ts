import { elastic } from '../ui/theme.js';

interface Style {
  fg?: string;
  bg?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
}

interface Cell {
  ch: string;
  style: Style;
}

const BASIC: Record<number, string> = {
  0: '#1A1C21',
  1: '#F86B63',
  2: '#7DDED8',
  3: '#FEC514',
  4: '#1BA9F5',
  5: '#F04E98',
  6: '#00BFB3',
  7: '#DFE5EF',
  8: '#69707D',
  9: '#FF8A80',
  10: '#9EF3EC',
  11: '#FFD75E',
  12: '#5BC2FF',
  13: '#FF7DB8',
  14: '#3BE3D6',
  15: '#FFFFFF',
};

function color256(n: number): string {
  if (n < 16) return BASIC[n];
  if (n < 232) {
    const i = n - 16;
    const r = Math.floor(i / 36);
    const g = Math.floor((i % 36) / 6);
    const b = i % 6;
    const v = (x: number) => (x === 0 ? 0 : 55 + x * 40);
    return `#${[v(r), v(g), v(b)].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
  }
  const gray = 8 + (n - 232) * 10;
  return `#${gray.toString(16).padStart(2, '0').repeat(3)}`;
}

const fresh = (): Style => ({ bold: false, dim: false, italic: false, underline: false, inverse: false });

function applySgr(params: number[], style: Style): Style {
  const s = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) Object.assign(s, fresh(), { fg: undefined, bg: undefined });
    else if (p === 1) s.bold = true;
    else if (p === 2) s.dim = true;
    else if (p === 3) s.italic = true;
    else if (p === 4) s.underline = true;
    else if (p === 7) s.inverse = true;
    else if (p === 22) (s.bold = false), (s.dim = false);
    else if (p === 23) s.italic = false;
    else if (p === 24) s.underline = false;
    else if (p === 27) s.inverse = false;
    else if (p >= 30 && p <= 37) s.fg = BASIC[p - 30];
    else if (p >= 90 && p <= 97) s.fg = BASIC[p - 90 + 8];
    else if (p === 39) s.fg = undefined;
    else if (p >= 40 && p <= 47) s.bg = BASIC[p - 40];
    else if (p >= 100 && p <= 107) s.bg = BASIC[p - 100 + 8];
    else if (p === 49) s.bg = undefined;
    else if ((p === 38 || p === 48) && params[i + 1] === 2) {
      const hex = `#${[params[i + 2], params[i + 3], params[i + 4]].map((x) => (x ?? 0).toString(16).padStart(2, '0')).join('')}`;
      if (p === 38) s.fg = hex;
      else s.bg = hex;
      i += 4;
    } else if ((p === 38 || p === 48) && params[i + 1] === 5) {
      const hex = color256(params[i + 2] ?? 0);
      if (p === 38) s.fg = hex;
      else s.bg = hex;
      i += 2;
    }
  }
  return s;
}

/** Parses an ANSI frame into a grid of styled cells. */
export function parseAnsi(frame: string): Cell[][] {
  const lines: Cell[][] = [[]];
  let style = fresh();
  let i = 0;
  while (i < frame.length) {
    const ch = frame[i];
    if (ch === '\u001b' && frame[i + 1] === '[') {
      let j = i + 2;
      while (j < frame.length && !/[A-Za-z]/.test(frame[j])) j++;
      const final = frame[j];
      const body = frame.slice(i + 2, j);
      if (final === 'm') style = applySgr(body ? body.split(';').map((x) => Number(x) || 0) : [0], style);
      i = j + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push([]);
      i++;
      continue;
    }
    if (ch === '\r') {
      i++;
      continue;
    }
    lines[lines.length - 1].push({ ch, style });
    i++;
  }
  if (lines.length && lines[lines.length - 1].length === 0) lines.pop();
  return lines;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export interface SvgOptions {
  title?: string;
  fontSize?: number;
  columns?: number;
  rows?: number;
  fontFamily?: string;
}

/** Renders an ANSI frame as an SVG terminal window in Elastic colors. */
export function ansiToSvg(frame: string, options: SvgOptions = {}): string {
  const grid = parseAnsi(frame);
  const fontSize = options.fontSize ?? 13;
  const cw = fontSize * 0.602;
  const lh = Math.round(fontSize * 1.5);
  const cols = options.columns ?? Math.max(...grid.map((l) => l.length), 80);
  const rows = options.rows ?? grid.length;
  const pad = 14;
  const bar = 34;
  const width = Math.round(cols * cw + pad * 2);
  const height = Math.round(rows * lh + pad * 2 + bar);
  const family = options.fontFamily ?? "'JetBrains Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace";
  const defaultFg = elastic.text;
  const bgColor = elastic.ink;
  const rects: string[] = [];
  const texts: string[] = [];

  grid.slice(0, rows).forEach((line, r) => {
    const y = bar + pad + r * lh;
    const baseline = y + Math.round(lh * 0.74);
    let runs: Array<{ text: string; style: Style }> = [];
    for (const cell of line) {
      const last = runs[runs.length - 1];
      if (last && sameStyle(last.style, cell.style)) last.text += cell.ch;
      else runs.push({ text: cell.ch, style: cell.style });
    }
    runs = runs.slice(0, 10_000);
    let x = pad;
    const spans: string[] = [];
    for (const run of runs) {
      const w = run.text.length * cw;
      let fg = run.style.fg ?? defaultFg;
      let bg = run.style.bg;
      if (run.style.inverse) [fg, bg] = [bg ?? bgColor, fg];
      if (bg) rects.push(`<rect x="${x.toFixed(1)}" y="${y}" width="${w.toFixed(1)}" height="${lh}" fill="${bg}"/>`);
      if (run.text.trim()) {
        const attrs = [`fill="${fg}"`];
        if (run.style.bold) attrs.push('font-weight="700"');
        if (run.style.italic) attrs.push('font-style="italic"');
        if (run.style.underline) attrs.push('text-decoration="underline"');
        if (run.style.dim) attrs.push('opacity="0.7"');
        spans.push(`<tspan x="${x.toFixed(1)}" ${attrs.join(' ')}>${esc(run.text)}</tspan>`);
      }
      x += w;
    }
    if (spans.length) texts.push(`<text y="${baseline}" xml:space="preserve">${spans.join('')}</text>`);
  });

  const title = esc(options.title ?? 'kibanaut');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${family}" font-size="${fontSize}">
<rect x="0" y="0" width="${width}" height="${height}" rx="12" fill="${bgColor}"/>
<path d="M0 12 Q0 0 12 0 H${width - 12} Q${width} 0 ${width} 12 V${bar} H0 Z" fill="#25262E"/>
<circle cx="20" cy="17" r="6" fill="${elastic.pink}"/><circle cx="40" cy="17" r="6" fill="${elastic.yellow}"/><circle cx="60" cy="17" r="6" fill="${elastic.teal}"/>
<text x="${width / 2}" y="22" text-anchor="middle" fill="${elastic.mediumShade}" font-size="12">${title}</text>
<g>${rects.join('')}</g>
<g style="white-space:pre">${texts.join('\n')}</g>
</svg>
`;
}

function sameStyle(a: Style, b: Style): boolean {
  return a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.underline === b.underline && a.inverse === b.inverse;
}
