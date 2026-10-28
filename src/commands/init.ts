import * as clack from '@clack/prompts';
import { loadConfig, saveConfig, upsertProfile, type Profile } from '../config/config.js';
import { authorizationHeader, createSecretStore, type Secret } from '../config/credentials.js';
import { createTransport, esInfo, kibanaStatus, runEsql, TransportError, type Transport } from '../transport/index.js';
import { createPainter, elastic, wordmark } from '../ui/theme.js';
import { DEFINITIONS_ES_TAG } from '../definitions/index.js';

export interface InitOptions {
  profile?: string;
  kibanaUrl?: string;
  space?: string;
  esUrl?: string;
  via?: 'kibana' | 'es';
  apiKey?: string;
  /** Read the API key from stdin (for scripts; keeps it out of shell history). */
  apiKeyStdin?: boolean;
  username?: string;
  password?: string;
  insecure?: boolean;
  nonInteractive?: boolean;
  /** Exchange username/password for a scoped API key instead of storing the password. */
  createApiKey?: boolean;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  return url.replace(/\/+$/, '');
}

function validateUrl(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return 'Enter a URL';
  try {
    new URL(normalizeUrl(raw));
    return undefined;
  } catch {
    return 'That does not look like a URL';
  }
}

async function exchangeForApiKey(profile: Profile, password: string, name: string): Promise<Secret> {
  const basic = createTransport({ ...profile, auth: 'basic' }, { type: 'basic', value: password });
  const res = await basic.es<{ encoded?: string }>('POST', '_security/api_key', {
    name,
    role_descriptors: {},
    metadata: { application: 'kibanaut', created_at: new Date().toISOString() },
  });
  if (!res.encoded) throw new TransportError('Elasticsearch did not return an encoded API key');
  return { type: 'apiKey', value: res.encoded };
}

export async function verifyConnection(transport: Transport): Promise<{ kibanaVersion?: string; esVersion?: string; clusterName?: string }> {
  const [status, info] = await Promise.all([kibanaStatus(transport).catch(() => undefined), esInfo(transport)]);
  await runEsql(transport, { query: 'ROW ok = 1 | LIMIT 1' });
  return { kibanaVersion: status?.version, esVersion: info.version, clusterName: info.clusterName };
}

export async function runInit(options: InitOptions): Promise<Profile> {
  const p = createPainter();
  const interactive = !options.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  const store = await createSecretStore();

  if (interactive) {
    clack.intro(`${wordmark(p)} ${p.muted('first-run setup')}`);
    clack.log.message(`Credentials will be stored in ${p.accent(store.name)}; nothing secret is written to the config file.`);
  }

  const ask = async <T>(value: T | undefined, prompt: () => Promise<T | symbol>, required = true): Promise<T> => {
    if (value !== undefined) return value;
    if (!interactive) throw new Error('Missing a required value and no TTY is attached. Pass it as a flag (see `kibanaut init --help`).');
    const answer = await prompt();
    if (clack.isCancel(answer)) {
      clack.cancel('Setup cancelled.');
      process.exit(1);
    }
    if (required && (answer === undefined || answer === '')) throw new Error('A value is required');
    return answer as T;
  };

  const name = await ask(options.profile, () => clack.text({ message: 'Profile name', placeholder: 'prod', defaultValue: 'default', initialValue: 'default' }));
  const via = options.via ?? (options.esUrl && !options.kibanaUrl ? 'es' : 'kibana');
  const kibanaUrl = normalizeUrl(await ask(options.kibanaUrl, () => clack.text({ message: 'Kibana URL', placeholder: 'https://my-deployment.kb.us-east-1.aws.elastic.cloud', validate: validateUrl })));
  const space = await ask(
    options.space ?? (options.nonInteractive ? '' : undefined),
    () => clack.text({ message: 'Kibana space (leave empty for default)', placeholder: 'default', defaultValue: '' }),
    false,
  );
  const esUrl = via === 'es' ? normalizeUrl(await ask(options.esUrl, () => clack.text({ message: 'Elasticsearch URL', validate: validateUrl }))) : options.esUrl ? normalizeUrl(options.esUrl) : undefined;

  let method: 'apiKey' | 'basic' = options.apiKey || options.apiKeyStdin ? 'apiKey' : options.username ? 'basic' : 'apiKey';
  if (interactive && !options.apiKey && !options.apiKeyStdin && !options.username) {
    method = (await ask(undefined, () =>
      clack.select({
        message: 'How do you want to authenticate?',
        options: [
          { value: 'apiKey', label: 'API key', hint: 'paste a key created in Kibana > Stack Management > API keys' },
          { value: 'basic', label: 'Username and password', hint: 'exchanged for a scoped API key; the password is not stored' },
        ],
      }),
    )) as 'apiKey' | 'basic';
  }

  const profile: Profile = {
    name,
    kibanaUrl,
    space: space?.trim() || undefined,
    esUrl,
    via,
    auth: 'apiKey',
    insecure: options.insecure || undefined,
  };

  let secret: Secret;
  if (method === 'apiKey') {
    const key = options.apiKeyStdin ? await readStdin() : await ask(options.apiKey, () => clack.password({ message: 'API key (encoded form, as shown by Kibana)', mask: '•' }));
    secret = { type: 'apiKey', value: key.trim().replace(/^ApiKey\s+/i, '') };
  } else {
    const username = await ask(options.username, () => clack.text({ message: 'Username', placeholder: 'elastic' }));
    const password = await ask(options.password, () => clack.password({ message: 'Password', mask: '•' }));
    const createKey = options.createApiKey ?? true;
    profile.username = username;
    if (createKey) {
      const spin = interactive ? clack.spinner() : undefined;
      spin?.start('Creating a scoped API key for kibanaut');
      try {
        secret = await exchangeForApiKey(profile, password, `kibanaut-${name}-${new Date().toISOString().slice(0, 10)}`);
        spin?.stop('API key created; the password will not be stored');
      } catch (err) {
        spin?.stop(p.warn(`Could not create an API key (${(err as Error).message}); storing the password instead`));
        profile.auth = 'basic';
        secret = { type: 'basic', value: password };
      }
    } else {
      profile.auth = 'basic';
      secret = { type: 'basic', value: password };
    }
  }

  const spin = interactive ? clack.spinner() : undefined;
  spin?.start(`Verifying access to ${profile.via === 'es' ? esUrl : kibanaUrl}`);
  try {
    const transport = createTransport(profile, secret);
    const info = await verifyConnection(transport);
    profile.esVersion = info.esVersion;
    const parts = [info.clusterName && `cluster ${info.clusterName}`, info.esVersion && `Elasticsearch ${info.esVersion}`, info.kibanaVersion && `Kibana ${info.kibanaVersion}`].filter(Boolean).join(', ');
    spin?.stop(`Connected: ${parts}`);
    if (!interactive) console.log(`Connected: ${parts}`);
    const bundled = DEFINITIONS_ES_TAG.replace(/^v/, '');
    if (info.esVersion && info.esVersion.split('.').slice(0, 2).join('.') !== bundled.split('.').slice(0, 2).join('.')) {
      const note = `Bundled ES|QL definitions are from ${bundled}; the cluster runs ${info.esVersion}. Lint may miss or over-report newer functions (npm run sync-definitions -- --tag v${info.esVersion}).`;
      if (interactive) clack.log.warn(note);
      else console.error(note);
    }
  } catch (err) {
    spin?.stop(p.err('Verification failed'));
    const msg = err instanceof TransportError && err.status === 401 ? 'Authentication failed (401). Check the key or password.' : (err as Error).message;
    if (interactive) {
      clack.log.error(msg);
      const keep = await clack.confirm({ message: 'Save the profile anyway?', initialValue: false });
      if (clack.isCancel(keep) || !keep) {
        clack.cancel('Nothing saved.');
        process.exit(1);
      }
    } else {
      throw new Error(msg);
    }
  }

  await store.set(name, secret);
  const config = upsertProfile(loadConfig(), profile, true);
  saveConfig(config);
  if (interactive) {
    clack.log.success(`Profile ${p.accent(name)} saved; secret kept in ${store.name}.`);
    clack.outro(`Run ${p.hex(elastic.blue)('kibanaut')} to open the TUI, or ${p.hex(elastic.blue)('kibanaut query "FROM logs-* | LIMIT 10"')}`);
  } else {
    console.log(`Profile ${name} saved; secret kept in ${store.name}.`);
  }
  return profile;
}

/** Header value for debugging `kibanaut config show-auth` style commands (never prints the secret). */
export function describeAuth(secret: Secret, username?: string): string {
  const header = authorizationHeader(secret, username);
  return `${header.split(' ')[0]} ••••${header.slice(-4)}`;
}
