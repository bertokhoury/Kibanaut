#!/usr/bin/env node
/**
 * Regenerates docs/screenshots/*.svg and *.png from real TUI frames rendered
 * against the demo backend. Run after `npm run build`:
 *
 *   npm run screenshots
 *
 * PNGs are rasterized with resvg; SVGs are kept too because GitHub renders them
 * crisply at any zoom level.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = resolve(root, 'docs', 'screenshots');
mkdirSync(outDir, { recursive: true });

const scenes = [
  ['editor', 'Editor with syntax highlighting'],
  ['completion', 'Completion popup'],
  ['lint', 'Live lint with did-you-mean'],
  ['results', 'Query results'],
  ['record', 'Record view'],
];
const columns = Number(process.env.SHOT_COLUMNS ?? 108);
const rows = Number(process.env.SHOT_ROWS ?? 30);

for (const [scene] of scenes) {
  const svgPath = resolve(outDir, `${scene}.svg`);
  execFileSync(process.execPath, [resolve(root, 'dist', 'cli.js'), 'snapshot', '--scene', scene, '--out', svgPath, '--columns', String(columns), '--rows', String(rows)], {
    env: { ...process.env, FORCE_COLOR: '3', KIBANAUT_CONFIG_DIR: resolve(root, '.kibanaut-local'), KIBANAUT_STATE_DIR: resolve(root, '.kibanaut-local'), KIBANAUT_CACHE_DIR: resolve(root, '.kibanaut-local') },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  const svg = readFileSync(svgPath, 'utf8');
  const png = new Resvg(svg, {
    fitTo: { mode: 'zoom', value: 2 },
    font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans Mono', monospaceFamily: 'DejaVu Sans Mono' },
  })
    .render()
    .asPng();
  writeFileSync(resolve(outDir, `${scene}.png`), png);
  console.log(`${scene}: ${svgPath.replace(root + '/', '')} (${Math.round(svg.length / 1024)} KB), png ${Math.round(png.length / 1024)} KB`);
}
