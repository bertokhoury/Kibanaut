import type { Profile } from '../config/config.js';
import { authorizationHeader, type Secret } from '../config/credentials.js';

export class TransportError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message);
    this.name = 'TransportError';
  }
}

export interface EsqlColumn {
  name: string;
  type: string;
}

export interface EsqlResponse {
  columns: EsqlColumn[];
  values: unknown[][];
  took?: number;
  is_partial?: boolean;
  id?: string;
  is_running?: boolean;
  profile?: unknown;
  /** Set when a column appears in `all_columns` but was dropped for being all-null. */
  all_columns?: EsqlColumn[];
}

export interface EsqlRequest {
  query: string;
  params?: Array<Record<string, unknown> | unknown>;
  dropNullColumns?: boolean;
  profile?: boolean;
  /** Pre-filter in Query DSL, applied before the ES|QL pipeline. */
  filter?: Record<string, unknown>;
  async?: boolean;
  waitForCompletionTimeout?: string;
  keepAlive?: string;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}

export interface KibanaStatus {
  version?: string;
  name?: string;
  status?: string;
}

export interface Transport {
  readonly kind: 'kibana' | 'es' | 'demo';
  describe(): string;
  /** Sends a request to Elasticsearch (through Kibana's console proxy when kind is `kibana`). */
  es<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  /** Sends a request to the Kibana HTTP API; undefined when no Kibana URL is configured. */
  kibana?<T = unknown>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T>;
  kibanaUrl?: string;
  space?: string;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const b = body as { error?: { reason?: string; type?: string; root_cause?: Array<{ reason?: string }> } | string; message?: string; statusCode?: number };
    if (typeof b.error === 'string') return b.error;
    const reason = b.error?.root_cause?.[0]?.reason ?? b.error?.reason ?? b.message;
    if (reason) return reason;
  }
  if (typeof body === 'string' && body.trim()) return body.slice(0, 300);
  return `HTTP ${status}`;
}

export function kibanaBase(profile: Pick<Profile, 'kibanaUrl' | 'space'>): string {
  const base = trimSlash(profile.kibanaUrl);
  return profile.space && profile.space !== 'default' ? `${base}/s/${encodeURIComponent(profile.space)}` : base;
}

export function createTransport(profile: Profile, secret: Secret): Transport {
  const headers: Record<string, string> = {
    Authorization: authorizationHeader(secret, profile.username),
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'User-Agent': 'kibanaut',
  };
  if (profile.insecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

  async function send<T>(url: string, method: string, body: unknown, extraHeaders: Record<string, string>, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { ...headers, ...extraHeaders },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal,
      });
    } catch (err) {
      const cause = (err as { cause?: { code?: string; message?: string } }).cause;
      throw new TransportError(`Could not reach ${new URL(url).origin}: ${cause?.code ?? cause?.message ?? (err as Error).message}`);
    }
    const data = await readBody(res);
    if (!res.ok) throw new TransportError(errorMessage(data, res.status), res.status, data);
    return data as T;
  }

  const kibanaRoot = profile.kibanaUrl ? kibanaBase(profile) : undefined;

  const kibana = kibanaRoot
    ? <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) =>
        send<T>(`${kibanaRoot}/${path.replace(/^\/+/, '')}`, method, body, { 'kbn-xsrf': 'true', 'x-elastic-internal-origin': 'kibanaut' }, signal)
    : undefined;

  if (profile.via === 'es') {
    if (!profile.esUrl) throw new TransportError('Profile uses direct Elasticsearch access but has no esUrl');
    const esRoot = trimSlash(profile.esUrl);
    return {
      kind: 'es',
      kibanaUrl: profile.kibanaUrl || undefined,
      space: profile.space,
      describe: () => `Elasticsearch ${esRoot}`,
      es: <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) => send<T>(`${esRoot}/${path.replace(/^\/+/, '')}`, method, body, {}, signal),
      kibana,
    };
  }

  if (!kibanaRoot) throw new TransportError('Profile has no Kibana URL');
  return {
    kind: 'kibana',
    kibanaUrl: profile.kibanaUrl,
    space: profile.space,
    describe: () => `Kibana ${kibanaRoot}`,
    es: <T>(method: string, path: string, body?: unknown, signal?: AbortSignal) => {
      const proxy = `${kibanaRoot}/api/console/proxy?path=${encodeURIComponent(path.replace(/^\/+/, ''))}&method=${encodeURIComponent(method.toUpperCase())}`;
      return send<T>(proxy, 'POST', body, { 'kbn-xsrf': 'true' }, signal);
    },
    kibana,
  };
}

export async function kibanaStatus(transport: Transport): Promise<KibanaStatus | undefined> {
  if (!transport.kibana) return undefined;
  const status = await transport.kibana<{ version?: { number?: string }; name?: string; status?: { overall?: { level?: string; state?: string } } }>('GET', 'api/status');
  return { version: status.version?.number, name: status.name, status: status.status?.overall?.level ?? status.status?.overall?.state };
}

export async function esInfo(transport: Transport): Promise<{ version?: string; clusterName?: string }> {
  const info = await transport.es<{ version?: { number?: string }; cluster_name?: string }>('GET', '');
  return { version: info.version?.number, clusterName: info.cluster_name };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Runs an ES|QL query, transparently polling the async API when requested. */
export async function runEsql(transport: Transport, req: EsqlRequest): Promise<EsqlResponse> {
  const body: Record<string, unknown> = { query: req.query };
  if (req.params?.length) body.params = req.params;
  if (req.dropNullColumns) body.drop_null_columns = true;
  if (req.profile) body.profile = true;
  if (req.filter) body.filter = req.filter;

  if (!req.async) {
    return transport.es<EsqlResponse>('POST', '_query?format=json', body, req.signal);
  }

  body.wait_for_completion_timeout = req.waitForCompletionTimeout ?? '1s';
  body.keep_alive = req.keepAlive ?? '5m';
  let res = await transport.es<EsqlResponse>('POST', '_query/async?format=json', body, req.signal);
  while (res.is_running && res.id) {
    await sleep(req.pollIntervalMs ?? 500);
    if (req.signal?.aborted) {
      await transport.es('DELETE', `_query/async/${res.id}`).catch(() => undefined);
      throw new TransportError('Query cancelled');
    }
    res = await transport.es<EsqlResponse>('GET', `_query/async/${res.id}?wait_for_completion_timeout=1s`, undefined, req.signal);
  }
  if (res.id) await transport.es('DELETE', `_query/async/${res.id}`).catch(() => undefined);
  return res;
}

/** Converts `--param name=value` pairs into the ES|QL params array, inferring JSON scalars. */
export function parseParams(pairs: string[]): Array<Record<string, unknown>> {
  return pairs.map((pair) => {
    const idx = pair.indexOf('=');
    if (idx <= 0) throw new Error(`Parameter "${pair}" must be name=value`);
    const name = pair.slice(0, idx).trim();
    const raw = pair.slice(idx + 1);
    let value: unknown = raw;
    if (/^-?\d+(\.\d+)?$/.test(raw)) value = Number(raw);
    else if (/^(true|false)$/i.test(raw)) value = raw.toLowerCase() === 'true';
    else if (raw === 'null') value = null;
    else if (/^[\[{"]/.test(raw)) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    return { [name]: value };
  });
}
