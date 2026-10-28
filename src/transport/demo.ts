import { flattenArgs, isAssignment, isColumn, isFunction, isLiteral, isOption, isOrder, literalValue, parseQuery, type ESQLCommand, type ESQLSingleAstItem } from '../core/ast.js';
import type { Field } from '../core/types.js';
import { TransportError, type EsqlResponse, type Transport } from './index.js';

export const DEMO_FIELDS: Field[] = [
  { name: '@timestamp', type: 'date' },
  { name: 'host.name', type: 'keyword' },
  { name: 'service.name', type: 'keyword' },
  { name: 'http.request.method', type: 'keyword' },
  { name: 'http.response.status_code', type: 'integer' },
  { name: 'event.duration', type: 'long' },
  { name: 'url.path', type: 'keyword' },
  { name: 'client.ip', type: 'ip' },
  { name: 'client.geo.country_iso_code', type: 'keyword' },
  { name: 'user_agent.os.name', type: 'keyword' },
  { name: 'bytes', type: 'long' },
  { name: 'message', type: 'text' },
  { name: 'log.level', type: 'keyword' },
];

type Row = Record<string, unknown>;

/** Small deterministic PRNG so demo data (and screenshots) are reproducible. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function demoRows(count = 240, seed = 7): Row[] {
  const rnd = mulberry32(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
  const hosts = ['web-01', 'web-02', 'web-03', 'api-01', 'api-02', 'edge-eu-1'];
  const services = ['storefront', 'checkout', 'search-api', 'auth', 'cdn-edge'];
  const paths = ['/', '/search', '/cart', '/checkout', '/api/v2/products', '/api/v2/orders', '/login', '/health'];
  const countries = ['US', 'DE', 'GB', 'FR', 'JP', 'BR', 'IN', 'CA'];
  const oses = ['Mac OS X', 'Windows', 'iOS', 'Android', 'Linux'];
  const base = Date.UTC(2026, 9, 27, 14, 0, 0);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const r = rnd();
    const status = r < 0.82 ? 200 : r < 0.88 ? 301 : r < 0.94 ? 404 : r < 0.975 ? 500 : 503;
    const method = pick(['GET', 'GET', 'GET', 'POST', 'PUT', 'DELETE']);
    const path = pick(paths);
    const duration = Math.round((status >= 500 ? 1800 : 40) + rnd() * (status >= 500 ? 4000 : 600)) * 1_000_000;
    rows.push({
      '@timestamp': new Date(base - i * 15_000 - Math.floor(rnd() * 9000)).toISOString(),
      'host.name': pick(hosts),
      'service.name': pick(services),
      'http.request.method': method,
      'http.response.status_code': status,
      'event.duration': duration,
      'url.path': path,
      'client.ip': `${10 + Math.floor(rnd() * 200)}.${Math.floor(rnd() * 255)}.${Math.floor(rnd() * 255)}.${1 + Math.floor(rnd() * 250)}`,
      'client.geo.country_iso_code': pick(countries),
      'user_agent.os.name': pick(oses),
      bytes: Math.round(200 + rnd() * 24_000),
      message: `${method} ${path} ${status} ${Math.round(duration / 1_000_000)}ms`,
      'log.level': status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info',
    });
  }
  return rows;
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

const AGGS = new Set(['count', 'count_distinct', 'sum', 'avg', 'min', 'max', 'median', 'values']);

function evalExpr(node: ESQLSingleAstItem | undefined, row: Row, group?: Row[]): unknown {
  if (!node) return null;
  if (isLiteral(node)) {
    const v = literalValue(node);
    if (node.literalType === 'integer' || node.literalType === 'double') return Number(v);
    if (node.literalType === 'boolean') return v.toLowerCase() === 'true';
    if (node.literalType === 'null') return null;
    return v;
  }
  if (isColumn(node)) return row[node.name] ?? null;
  if (isFunction(node)) {
    const args = flattenArgs(node.args);
    if (group && AGGS.has(node.name.toLowerCase())) {
      const arg = args[0];
      const star = !arg || (isColumn(arg) && arg.name === '*');
      return aggregate(node.name.toLowerCase(), group.map((r) => (star ? 1 : evalExpr(arg, r))));
    }
    const [a, b] = args.map((x) => evalExpr(x, row, group));
    switch (node.name.toLowerCase()) {
      case 'and':
        return Boolean(a) && Boolean(b);
      case 'or':
        return Boolean(a) || Boolean(b);
      case 'not':
        return !a;
      case '==':
        return a === b;
      case '!=':
        return a !== b;
      case '>':
        return cmp(a, b) > 0;
      case '>=':
        return cmp(a, b) >= 0;
      case '<':
        return cmp(a, b) < 0;
      case '<=':
        return cmp(a, b) <= 0;
      case '+':
        return Number(a) + Number(b);
      case '-':
        return args.length === 1 ? -Number(a) : Number(a) - Number(b);
      case '*':
        return Number(a) * Number(b);
      case '/':
        return Number(a) / Number(b);
      case '%':
        return Number(a) % Number(b);
      case 'like': {
        const re = new RegExp(`^${String(b).split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
        return re.test(String(a));
      }
      case 'rlike':
        return new RegExp(`^${String(b)}$`).test(String(a));
      case 'in':
        return args.slice(1).some((x) => evalExpr(x, row) === a);
      case 'is null':
        return a === null || a === undefined;
      case 'is not null':
        return a !== null && a !== undefined;
      case 'round':
        return Math.round(Number(a) * 10 ** (Number(b ?? 0))) / 10 ** Number(b ?? 0);
      case 'to_string':
        return String(a);
      case 'to_integer':
      case 'to_long':
        return Math.trunc(Number(a));
      case 'to_double':
        return Number(a);
      case 'length':
        return String(a).length;
      case 'to_upper':
        return String(a).toUpperCase();
      case 'to_lower':
        return String(a).toLowerCase();
      case 'concat':
        return args.map((x) => String(evalExpr(x, row))).join('');
      case 'date_trunc': {
        const unit = String(a);
        const d = new Date(String(b));
        if (/hour/.test(unit)) d.setUTCMinutes(0, 0, 0);
        else if (/day/.test(unit)) d.setUTCHours(0, 0, 0, 0);
        else if (/minute/.test(unit)) d.setUTCSeconds(0, 0);
        return d.toISOString();
      }
      case 'bucket': {
        const d = new Date(String(a));
        d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 5) * 5, 0, 0);
        return d.toISOString();
      }
      case 'now':
        return new Date().toISOString();
      default:
        return null;
    }
  }
  return null;
}

function aggregate(name: string, values: unknown[]): unknown {
  const nums = values.filter((v) => typeof v === 'number') as number[];
  switch (name) {
    case 'count':
      return values.length;
    case 'count_distinct':
      return new Set(values.map(String)).size;
    case 'sum':
      return nums.reduce((a, b) => a + b, 0);
    case 'avg':
      return nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : null;
    case 'min':
      return nums.length ? Math.min(...nums) : null;
    case 'max':
      return nums.length ? Math.max(...nums) : null;
    case 'median':
      return nums.length ? [...nums].sort((a, b) => a - b)[Math.floor(nums.length / 2)] : null;
    case 'values':
      return [...new Set(values.map(String))].slice(0, 5);
    default:
      return null;
  }
}

/** Executes the subset of ES|QL the demo supports over the sample rows. */
export function runDemoQuery(query: string, source: Row[]): EsqlResponse {
  const parsed = parseQuery(query);
  if (parsed.syntaxErrors.length) throw new TransportError(`parsing_exception: ${parsed.syntaxErrors[0].message}`, 400);
  let rows: Row[] = [];
  let columns: string[] = [];
  const types = new Map(DEMO_FIELDS.map((f) => [f.name, f.type]));

  const applyAssign = (cmd: ESQLCommand, target: Row, sourceRow: Row, groupValues?: Row[]) => {
    for (const item of flattenArgs(cmd.args)) {
      if (isOption(item)) continue;
      const [lhs, rhs] = isAssignment(item) ? flattenArgs(item.args) : [undefined, item];
      const name = lhs && isColumn(lhs) ? lhs.name : item.text?.trim() || item.name;
      const value = evalExpr(rhs, sourceRow, groupValues);
      target[name] = typeof value === 'number' && !Number.isInteger(value) ? Math.round(value * 100) / 100 : value;
      const isCount = rhs && isFunction(rhs) && /^count/i.test(rhs.name);
      types.set(name, isCount ? 'long' : typeof value === 'number' ? (Number.isInteger(value) ? 'long' : 'double') : typeof value === 'boolean' ? 'boolean' : 'keyword');
      if (!columns.includes(name)) columns.push(name);
    }
  };

  for (const cmd of parsed.commands) {
    const args = flattenArgs(cmd.args);
    switch (cmd.name.toLowerCase()) {
      case 'from':
      case 'ts':
        rows = source.map((r) => ({ ...r }));
        columns = DEMO_FIELDS.map((f) => f.name);
        break;
      case 'row': {
        const row: Row = {};
        columns = [];
        applyAssign(cmd, row, {});
        rows = [row];
        break;
      }
      case 'show':
        rows = [{ version: '9.4.0', date: '2026-10-27T00:00:00.000Z', hash: 'demo' }];
        columns = ['version', 'date', 'hash'];
        break;
      case 'where':
        rows = rows.filter((r) => Boolean(evalExpr(args[0], r)));
        break;
      case 'eval':
        for (const r of rows) applyAssign(cmd, r, r);
        break;
      case 'stats': {
        const by = args.find((a) => isOption(a) && a.name === 'by');
        const keys = by && isOption(by) ? flattenArgs(by.args) : [];
        const groups = new Map<string, { key: Row; rows: Row[] }>();
        for (const r of rows) {
          const key: Row = {};
          for (const k of keys) {
            const [lhs, rhs] = isAssignment(k) ? flattenArgs(k.args) : [undefined, k];
            const name = lhs && isColumn(lhs) ? lhs.name : isColumn(k) ? k.name : k.text?.trim() || k.name;
            key[name] = evalExpr(rhs, r);
          }
          const id = JSON.stringify(key);
          const g = groups.get(id) ?? { key, rows: [] };
          g.rows.push(r);
          groups.set(id, g);
        }
        const keyNames = keys.map((k) => {
          const [lhs] = isAssignment(k) ? flattenArgs(k.args) : [undefined];
          return lhs && isColumn(lhs) ? lhs.name : isColumn(k) ? k.name : k.text?.trim() || k.name;
        });
        columns = [];
        const out: Row[] = [];
        for (const g of groups.values()) {
          const row: Row = {};
          applyAssign(cmd, row, g.rows[0], g.rows);
          Object.assign(row, g.key);
          out.push(row);
        }
        columns = [...columns, ...keyNames];
        rows = out;
        break;
      }
      case 'sort': {
        const orders = args.filter(isOrder);
        rows = [...rows].sort((a, b) => {
          for (const o of orders) {
            const col = flattenArgs(o.args)[0];
            const c = cmp(evalExpr(col, a), evalExpr(col, b));
            if (c !== 0) return o.order === 'DESC' ? -c : c;
          }
          return 0;
        });
        break;
      }
      case 'limit':
        rows = rows.slice(0, Number(evalExpr(args[0], {})));
        break;
      case 'keep':
        columns = args.filter(isColumn).flatMap((c) => (c.name.includes('*') ? columns.filter((x) => new RegExp(`^${c.name.replace(/\*/g, '.*')}$`).test(x)) : [c.name]));
        break;
      case 'drop': {
        const dropped = new Set(args.filter(isColumn).map((c) => c.name));
        columns = columns.filter((c) => !dropped.has(c));
        break;
      }
      case 'rename':
        for (const item of args) {
          if (!isFunction(item)) continue;
          const [a, b] = flattenArgs(item.args);
          const [from, to] = item.name === 'as' ? [a, b] : [b, a];
          if (isColumn(from) && isColumn(to)) {
            columns = columns.map((c) => (c === from.name ? to.name : c));
            for (const r of rows) {
              r[to.name] = r[from.name];
              delete r[from.name];
            }
          }
        }
        break;
      case 'mv_expand':
      case 'dedup':
      case 'sample':
        break;
      default:
        throw new TransportError(`${cmd.name.toUpperCase()} is not supported by the demo backend; connect to a cluster to run it`, 400);
    }
  }

  if (!parsed.commands.some((c) => c.name.toLowerCase() === 'limit')) rows = rows.slice(0, 1000);
  return {
    columns: columns.map((name) => ({ name, type: types.get(name) ?? 'keyword' })),
    values: rows.map((r) => columns.map((c) => r[c] ?? null)),
    took: 7 + Math.floor(rows.length / 20),
  };
}

export function createDemoTransport(rows = demoRows()): Transport {
  return {
    kind: 'demo',
    kibanaUrl: 'https://kibana.demo.local',
    describe: () => 'sample web logs, no cluster',
    async es<T>(method: string, path: string, body?: unknown): Promise<T> {
      if (path.startsWith('_query')) return runDemoQuery((body as { query: string }).query, rows) as T;
      if (path === '' || path === '/') return { version: { number: '9.4.0' }, cluster_name: 'kibanaut-demo' } as T;
      if (path.startsWith('_resolve/index')) return { indices: [{ name: 'logs-web-default' }], data_streams: [{ name: 'logs-*' }], aliases: [] } as T;
      if (path.startsWith('_enrich/policy')) return { policies: [{ config: { match: { name: 'geoip_policy' } } }] } as T;
      if (path.startsWith('_all/_settings')) return { hosts_lookup: { settings: { index: { mode: 'lookup' } } } } as T;
      throw new TransportError(`demo transport cannot ${method} ${path}`, 404);
    },
    async kibana<T>(method: string, path: string): Promise<T> {
      if (path === 'api/status') return { version: { number: '9.4.0' }, name: 'kibana-demo', status: { overall: { level: 'available' } } } as T;
      if (path === 'api/data_views') return { data_view: [{ name: 'Web logs', title: 'logs-*' }] } as T;
      throw new TransportError(`demo transport cannot ${method} ${path}`, 404);
    },
  };
}
