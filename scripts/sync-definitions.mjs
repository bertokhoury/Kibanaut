#!/usr/bin/env node
/**
 * Pulls ES|QL function and operator signatures from the Elasticsearch repo at a
 * release tag and writes a compact snapshot to src/definitions/functions.json.
 *
 *   node scripts/sync-definitions.mjs --tag v9.2.0
 *
 * The names come from @elastic/esql-definitions (kept in sync with the grammar);
 * the signatures come from the JSON Elasticsearch generates for Kibana.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionNames } from '@elastic/esql-definitions';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const tag = args[args.indexOf('--tag') + 1] || process.env.ES_TAG || 'v9.2.0';
const base = `https://raw.githubusercontent.com/elastic/elasticsearch/${tag}/docs/reference/query-languages/esql/kibana/definition`;

const OPERATORS = [
  'add', 'sub', 'mul', 'div', 'mod', 'neg', 'equals', 'not_equals', 'greater_than',
  'greater_than_or_equal', 'less_than', 'less_than_or_equal', 'in', 'like', 'rlike',
  'not', 'and', 'or', 'is_null', 'is_not_null', 'cast', 'match_operator', 'not_like',
  'not_rlike', 'not_in', 'predicates',
];

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

function compact(def) {
  return {
    name: def.name,
    type: def.type,
    description: def.description ?? '',
    signatures: (def.signatures ?? []).map((s) => ({
      params: (s.params ?? []).map((p) => ({
        name: p.name,
        type: p.type,
        optional: Boolean(p.optional),
        description: p.description ?? '',
      })),
      variadic: Boolean(s.variadic),
      returnType: s.returnType,
    })),
    examples: (def.examples ?? []).slice(0, 3),
    preview: Boolean(def.preview),
    snapshotOnly: Boolean(def.snapshot_only),
  };
}

async function pool(items, worker, size = 12) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const item = items[i++];
        out.push(await worker(item));
      }
    }),
  );
  return out;
}

const functions = {};
const operators = {};
let missing = [];

const fnResults = await pool(functionNames, async (name) => {
  const file = name.toLowerCase();
  const def = await fetchJson(`${base}/functions/${file}.json`);
  if (!def) {
    missing.push(name);
    return null;
  }
  return compact(def);
});
for (const def of fnResults) if (def) functions[def.name.toUpperCase()] = def;

const opResults = await pool(OPERATORS, async (name) => {
  const def = await fetchJson(`${base}/operators/${name}.json`);
  return def ? compact(def) : null;
});
for (const def of opResults) if (def) operators[def.name] = def;

const snapshot = {
  esTag: tag,
  generatedAt: new Date().toISOString(),
  functionCount: Object.keys(functions).length,
  operatorCount: Object.keys(operators).length,
  functions,
  operators,
};

const target = resolve(here, '..', 'src', 'definitions', 'functions.json');
await mkdir(dirname(target), { recursive: true });
await writeFile(target, JSON.stringify(snapshot, null, 1) + '\n');

console.log(`Wrote ${snapshot.functionCount} functions and ${snapshot.operatorCount} operators from ${tag} to ${target}`);
if (missing.length) console.log(`No definition found upstream for: ${missing.join(', ')}`);
