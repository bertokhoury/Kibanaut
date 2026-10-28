import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { APP_NAME, configDir } from './config.js';

const execFileAsync = promisify(execFile);

export interface Secret {
  type: 'apiKey' | 'basic';
  /** Base64 `id:api_key` for apiKey, the password for basic. */
  value: string;
}

export interface SecretStore {
  readonly name: string;
  get(profile: string): Promise<Secret | undefined>;
  set(profile: string, secret: Secret): Promise<void>;
  delete(profile: string): Promise<void>;
}

const SERVICE = `${APP_NAME}`;

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

/** macOS Keychain through the `security` CLI (what gh, aws-vault, and friends use). */
export class KeychainStore implements SecretStore {
  readonly name = 'macOS Keychain';
  async get(profile: string): Promise<Secret | undefined> {
    try {
      const { stdout } = await execFileAsync('security', ['find-generic-password', '-s', SERVICE, '-a', profile, '-w']);
      return JSON.parse(stdout.trim()) as Secret;
    } catch {
      return undefined;
    }
  }
  async set(profile: string, secret: Secret): Promise<void> {
    await execFileAsync('security', ['add-generic-password', '-U', '-s', SERVICE, '-a', profile, '-l', `${APP_NAME} (${profile})`, '-w', JSON.stringify(secret)]);
  }
  async delete(profile: string): Promise<void> {
    try {
      await execFileAsync('security', ['delete-generic-password', '-s', SERVICE, '-a', profile]);
    } catch {
      /* already gone */
    }
  }
}

/** Freedesktop Secret Service through `secret-tool` (GNOME Keyring, KWallet). */
export class SecretToolStore implements SecretStore {
  readonly name = 'Secret Service (secret-tool)';
  async get(profile: string): Promise<Secret | undefined> {
    try {
      const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', SERVICE, 'profile', profile]);
      return stdout ? (JSON.parse(stdout) as Secret) : undefined;
    } catch {
      return undefined;
    }
  }
  async set(profile: string, secret: Secret): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = execFile('secret-tool', ['store', `--label=${APP_NAME} (${profile})`, 'service', SERVICE, 'profile', profile], (err) => (err ? reject(err) : resolve()));
      child.stdin?.end(JSON.stringify(secret));
    });
  }
  async delete(profile: string): Promise<void> {
    try {
      await execFileAsync('secret-tool', ['clear', 'service', SERVICE, 'profile', profile]);
    } catch {
      /* already gone */
    }
  }
}

/** Plain file with 0600 permissions. Used when no OS keychain is available. */
export class FileStore implements SecretStore {
  readonly name = 'file (0600)';
  constructor(private readonly path = join(configDir(), 'credentials.json')) {}
  private read(): Record<string, Secret> {
    if (!existsSync(this.path)) return {};
    try {
      return JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, Secret>;
    } catch {
      return {};
    }
  }
  private write(data: Record<string, Secret>): void {
    mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    writeFileSync(this.path, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    chmodSync(this.path, 0o600);
  }
  async get(profile: string): Promise<Secret | undefined> {
    return this.read()[profile];
  }
  async set(profile: string, secret: Secret): Promise<void> {
    this.write({ ...this.read(), [profile]: secret });
  }
  async delete(profile: string): Promise<void> {
    const data = this.read();
    delete data[profile];
    this.write(data);
  }
}

/** Picks the best store for this machine. KIBANAUT_SECRET_STORE=file|keychain|secret-tool forces one. */
export async function createSecretStore(): Promise<SecretStore> {
  const forced = process.env.KIBANAUT_SECRET_STORE;
  if (forced === 'file') return new FileStore();
  if (forced === 'keychain') return new KeychainStore();
  if (forced === 'secret-tool') return new SecretToolStore();
  if (process.platform === 'darwin' && (await commandExists('security'))) return new KeychainStore();
  if (process.platform === 'linux' && (await commandExists('secret-tool'))) return new SecretToolStore();
  return new FileStore();
}

/** Secret for the active profile: env var first, then the store. */
export async function resolveSecret(profileName: string, store?: SecretStore): Promise<Secret | undefined> {
  if (process.env.KIBANAUT_API_KEY) return { type: 'apiKey', value: process.env.KIBANAUT_API_KEY };
  if (process.env.KIBANAUT_PASSWORD) return { type: 'basic', value: process.env.KIBANAUT_PASSWORD };
  const s = store ?? (await createSecretStore());
  return s.get(profileName);
}

/** Builds the Authorization header for a profile + secret pair. */
export function authorizationHeader(secret: Secret, username?: string): string {
  if (secret.type === 'apiKey') return `ApiKey ${secret.value}`;
  return `Basic ${Buffer.from(`${username ?? 'elastic'}:${secret.value}`).toString('base64')}`;
}
