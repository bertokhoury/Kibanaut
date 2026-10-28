import { hasAnyProfile, loadConfig, loadLintConfig, resolveProfile, type Config, type Profile } from '../config/config.js';
import { createSecretStore, resolveSecret } from '../config/credentials.js';
import type { LintConfig } from '../core/lint/index.js';
import type { Field, SchemaSource } from '../core/types.js';
import { createDemoTransport, DEMO_FIELDS } from '../transport/demo.js';
import { TransportError, type Transport } from '../transport/index.js';
import { DemoSchema, SchemaProvider } from '../transport/schema.js';

export interface Session {
  config: Config;
  profile: Profile;
  transport: Transport;
  schema: SchemaSource & { clear?(): void; listDataViews?(): Promise<Array<{ name: string; title: string }>> };
  lintConfig: LintConfig;
  demo: boolean;
  /** Resolves the columns for a query prefix, swallowing transport errors (returns undefined). */
  columnsFor(prefix: string): Promise<Field[] | undefined>;
}

export interface SessionOptions {
  profile?: string;
  demo?: boolean;
  /** Skip schema lookups entirely (lint offline, complete statically). */
  offline?: boolean;
}

export class NoProfileError extends Error {
  constructor() {
    super('No profile configured yet. Run `kibanaut init` (or try `kibanaut --demo`).');
    this.name = 'NoProfileError';
  }
}

export async function openSession(options: SessionOptions = {}): Promise<Session> {
  const config = loadConfig();
  const lintConfig = loadLintConfig(config);

  if (options.demo) {
    const transport = createDemoTransport();
    const schema = new DemoSchema(DEMO_FIELDS);
    return {
      config,
      profile: { name: 'demo', kibanaUrl: 'https://kibana.demo.local', via: 'kibana', auth: 'apiKey', esVersion: '9.4.0' },
      transport,
      schema,
      lintConfig,
      demo: true,
      columnsFor: async () => DEMO_FIELDS,
    };
  }

  if (!hasAnyProfile(config)) throw new NoProfileError();
  const resolved = resolveProfile(config, options.profile);
  if (!resolved) throw new Error(`Profile "${options.profile ?? config.currentProfile}" does not exist. Run \`kibanaut config list\`.`);

  const store = await createSecretStore();
  const secret = await resolveSecret(resolved.profile.name, store);
  if (!secret) {
    throw new Error(`No credentials stored for profile "${resolved.profile.name}" in ${store.name}. Run \`kibanaut init\` again, or set KIBANAUT_API_KEY.`);
  }

  const { createTransport } = await import('../transport/index.js');
  const transport = createTransport(resolved.profile, secret);
  const schema = new SchemaProvider(transport, { profile: resolved.profile.name, ttlSeconds: config.schemaTtlSeconds ?? 600 });

  return {
    config,
    profile: resolved.profile,
    transport,
    schema,
    lintConfig,
    demo: false,
    columnsFor: async (prefix: string) => {
      if (options.offline) return undefined;
      try {
        return await schema.columnsFor(prefix);
      } catch (err) {
        if (err instanceof TransportError && err.status && err.status >= 500) throw err;
        return undefined;
      }
    },
  };
}

/** The FROM/TS sources of a query, joined as `prefix` for `| LIMIT 0`. */
export function sourcePrefix(query: string): string | undefined {
  const m = /^\s*(?:FROM|TS)\s+([^|]+)/i.exec(query);
  if (!m) return undefined;
  return `FROM ${m[1].replace(/\bMETADATA\b[\s\S]*$/i, '').trim()}`;
}
