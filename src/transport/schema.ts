import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cacheDir } from '../config/config.js';
import type { Field, SchemaSource } from '../core/types.js';
import type { EsqlResponse, Transport } from './index.js';

interface CacheEntry<T> {
  value: T;
  expires: number;
}

export interface SchemaProviderOptions {
  ttlSeconds?: number;
  /** Profile name used to namespace the on-disk cache. */
  profile?: string;
  persist?: boolean;
  includeHidden?: boolean;
}

export class SchemaProvider implements SchemaSource {
  private memory = new Map<string, CacheEntry<unknown>>();
  private readonly ttlMs: number;
  private readonly file?: string;
  private readonly includeHidden: boolean;

  constructor(private readonly transport: Transport, options: SchemaProviderOptions = {}) {
    this.ttlMs = (options.ttlSeconds ?? 600) * 1000;
    this.includeHidden = options.includeHidden ?? false;
    if (options.persist !== false && options.profile) {
      this.file = join(cacheDir(), `${options.profile.replace(/[^A-Za-z0-9_-]/g, '_')}.schema.json`);
      this.load();
    }
  }

  private load(): void {
    if (!this.file || !existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, CacheEntry<unknown>>;
      const now = Date.now();
      for (const [k, v] of Object.entries(data)) if (v.expires > now) this.memory.set(k, v);
    } catch {
      /* ignore a corrupt cache */
    }
  }

  private persist(): void {
    if (!this.file) return;
    try {
      mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
      writeFileSync(this.file, JSON.stringify(Object.fromEntries(this.memory)), { mode: 0o600 });
    } catch {
      /* cache is best effort */
    }
  }

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = this.memory.get(key);
    if (hit && hit.expires > Date.now()) return hit.value as T;
    const value = await loader();
    this.memory.set(key, { value, expires: Date.now() + this.ttlMs });
    this.persist();
    return value;
  }

  clear(): void {
    this.memory.clear();
    this.persist();
  }

  async listSources(): Promise<string[]> {
    return this.cached('sources', async () => {
      const res = await this.transport.es<{ indices?: Array<{ name: string }>; aliases?: Array<{ name: string }>; data_streams?: Array<{ name: string }> }>(
        'GET',
        `_resolve/index/*?expand_wildcards=open${this.includeHidden ? ',hidden' : ''}`,
      );
      const names = [...(res.data_streams ?? []), ...(res.aliases ?? []), ...(res.indices ?? [])].map((x) => x.name);
      const visible = this.includeHidden ? names : names.filter((n) => !n.startsWith('.'));
      return [...new Set(visible)].sort();
    });
  }

  async columnsFor(queryPrefix: string): Promise<Field[]> {
    const key = `columns:${createHash('sha1').update(queryPrefix).digest('hex')}`;
    return this.cached(key, async () => {
      const res = await this.transport.es<EsqlResponse>('POST', '_query?format=json', { query: `${queryPrefix} | LIMIT 0` });
      return (res.columns ?? []).map((c) => ({ name: c.name, type: c.type }));
    });
  }

  async listPolicies(): Promise<string[]> {
    return this.cached('policies', async () => {
      const res = await this.transport.es<{ policies?: Array<{ config: Record<string, { name: string }> }> }>('GET', '_enrich/policy');
      return (res.policies ?? []).map((p) => Object.values(p.config)[0]?.name).filter((n): n is string => Boolean(n)).sort();
    });
  }

  async listLookupIndices(): Promise<string[]> {
    return this.cached('lookups', async () => {
      const res = await this.transport.es<Record<string, { settings?: { index?: { mode?: string } } }>>('GET', '_all/_settings/index.mode?filter_path=*.settings.index.mode');
      return Object.entries(res ?? {})
        .filter(([, v]) => v.settings?.index?.mode === 'lookup')
        .map(([k]) => k)
        .sort();
    });
  }

  /** Kibana data views (title -> index pattern), when a Kibana transport is available. */
  async listDataViews(): Promise<Array<{ name: string; title: string }>> {
    if (!this.transport.kibana) return [];
    return this.cached('dataviews', async () => {
      const res = await this.transport.kibana!<{ data_view?: Array<{ name?: string; title: string }> }>('GET', 'api/data_views');
      return (res.data_view ?? []).map((d) => ({ name: d.name ?? d.title, title: d.title }));
    });
  }
}

/** Static schema used by `--demo` and by tests. */
export class DemoSchema implements SchemaSource {
  constructor(private readonly fields: Field[], private readonly sources: string[] = ['logs-*', 'logs-web-default', 'metrics-system-default', 'kibana_sample_data_ecommerce']) {}
  async listSources(): Promise<string[]> {
    return this.sources;
  }
  async columnsFor(): Promise<Field[]> {
    return this.fields;
  }
  async listPolicies(): Promise<string[]> {
    return ['geoip_policy', 'host_owner_policy'];
  }
  async listLookupIndices(): Promise<string[]> {
    return ['hosts_lookup', 'services_lookup'];
  }
}

/** Rison string encoding as used in Kibana URLs. */
export function risonString(value: string): string {
  return `'${value.replace(/!/g, '!!').replace(/'/g, "!'")}'`;
}

/** Deep link that opens the query in Discover's ES|QL mode (best effort; Kibana owns the URL format). */
export function discoverLink(kibanaUrl: string, query: string, space?: string, timeRange: { from: string; to: string } = { from: 'now-15m', to: 'now' }): string {
  const base = kibanaUrl.replace(/\/+$/, '') + (space && space !== 'default' ? `/s/${encodeURIComponent(space)}` : '');
  const appState = `(query:(esql:${risonString(query.replace(/\s+/g, ' ').trim())}))`;
  const globalState = `(time:(from:${timeRange.from},to:${timeRange.to}))`;
  return `${base}/app/discover#/?_a=${encodeURIComponent(appState)}&_g=${encodeURIComponent(globalState)}`;
}
