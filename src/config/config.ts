import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LintConfig } from '../core/lint/index.js';

export interface Profile {
  name: string;
  /** Kibana base URL, e.g. https://kibana.example.com or https://host:5601. */
  kibanaUrl: string;
  /** Kibana space id; omitted or `default` means the default space. */
  space?: string;
  /** Optional direct Elasticsearch URL used when `via` is `es`. */
  esUrl?: string;
  /** Which transport runs queries. Kibana is the default and only needs the Kibana URL. */
  via: 'kibana' | 'es';
  auth: 'apiKey' | 'basic';
  username?: string;
  /** Skip TLS verification (self-signed clusters). */
  insecure?: boolean;
  /** Elasticsearch version reported during init; used for grammar-drift hints. */
  esVersion?: string;
}

export interface Config {
  version: 1;
  currentProfile?: string;
  profiles: Record<string, Profile>;
  lint?: LintConfig;
  /** Default output format for `query` when not specified. */
  format?: string;
  /** Seconds before cached schema entries expire. */
  schemaTtlSeconds?: number;
}

export const APP_NAME = 'kibanaut';

export function configDir(): string {
  return process.env.KIBANAUT_CONFIG_DIR ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), APP_NAME);
}

export function cacheDir(): string {
  return process.env.KIBANAUT_CACHE_DIR ?? join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), APP_NAME);
}

export function stateDir(): string {
  return process.env.KIBANAUT_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), APP_NAME);
}

export function configPath(): string {
  return join(configDir(), 'config.json');
}

const EMPTY: Config = { version: 1, profiles: {} };

export function loadConfig(): Config {
  const path = configPath();
  if (!existsSync(path)) return structuredClone(EMPTY);
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Config;
    return { ...structuredClone(EMPTY), ...parsed, profiles: parsed.profiles ?? {} };
  } catch (err) {
    throw new Error(`Config at ${path} is not valid JSON: ${(err as Error).message}`);
  }
}

export function saveConfig(config: Config): void {
  mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(), JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

export function upsertProfile(config: Config, profile: Profile, makeCurrent = true): Config {
  const next = { ...config, profiles: { ...config.profiles, [profile.name]: profile } };
  if (makeCurrent || !next.currentProfile) next.currentProfile = profile.name;
  return next;
}

export interface ResolvedProfile {
  profile: Profile;
  /** True when the profile was synthesized from environment variables. */
  fromEnv: boolean;
}

/**
 * Resolves the active profile. Environment variables win so CI can run without
 * a config file: KIBANAUT_KIBANA_URL (+ KIBANAUT_API_KEY) or KIBANAUT_PROFILE.
 */
export function resolveProfile(config: Config, requested?: string): ResolvedProfile | undefined {
  const envUrl = process.env.KIBANAUT_KIBANA_URL;
  const envEs = process.env.KIBANAUT_ES_URL;
  if (envUrl || envEs) {
    return {
      fromEnv: true,
      profile: {
        name: 'env',
        kibanaUrl: envUrl ?? '',
        esUrl: envEs,
        via: envUrl ? 'kibana' : 'es',
        space: process.env.KIBANAUT_SPACE,
        auth: process.env.KIBANAUT_USERNAME ? 'basic' : 'apiKey',
        username: process.env.KIBANAUT_USERNAME,
        insecure: process.env.KIBANAUT_INSECURE === '1',
      },
    };
  }
  const name = requested ?? process.env.KIBANAUT_PROFILE ?? config.currentProfile;
  if (!name) return undefined;
  const profile = config.profiles[name];
  return profile ? { profile, fromEnv: false } : undefined;
}

export function hasAnyProfile(config: Config): boolean {
  return Object.keys(config.profiles).length > 0 || Boolean(process.env.KIBANAUT_KIBANA_URL || process.env.KIBANAUT_ES_URL);
}

/** Looks for .kibanautrc.json from `cwd` upward and merges it over the config's lint settings. */
export function loadLintConfig(config: Config, cwd = process.cwd()): LintConfig {
  let dir = cwd;
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, '.kibanautrc.json');
    if (existsSync(candidate)) {
      try {
        const rc = JSON.parse(readFileSync(candidate, 'utf8')) as LintConfig & { lint?: LintConfig };
        const merged = rc.lint ?? rc;
        return { ...config.lint, ...merged, rules: { ...config.lint?.rules, ...merged.rules } };
      } catch (err) {
        throw new Error(`${candidate} is not valid JSON: ${(err as Error).message}`);
      }
    }
    const parent = join(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return config.lint ?? {};
}
