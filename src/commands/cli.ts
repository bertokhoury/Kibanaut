import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { configPath, loadConfig, saveConfig, type Config } from '../config/config.js';
import { createSecretStore } from '../config/credentials.js';
import { complete, pipelinePrefix } from '../core/complete.js';
import { lookupDoc, searchDocs } from '../core/docs.js';
import { formatQuery } from '../core/format.js';
import { lintQuery, RULES } from '../core/lint/index.js';
import type { Field } from '../core/types.js';
import { renderDiagnostics, type LintFormat } from '../render/diagnostics.js';
import { renderResult, type OutputFormat } from '../render/formats.js';
import { parseParams, runEsql, TransportError } from '../transport/index.js';
import { discoverLink } from '../transport/schema.js';
import { createPainter, elastic, KIND_GLYPHS, type Painter } from '../ui/theme.js';
import { openSession, sourcePrefix, type Session, type SessionOptions } from './session.js';

export interface CommonOptions extends SessionOptions {
  color?: boolean;
}

export function painterFor(options: CommonOptions): Painter {
  return createPainter({ color: options.color });
}

export function readQueryInput(query: string | undefined, file: string | undefined): string {
  if (file) {
    if (file === '-') return readFileSync(0, 'utf8');
    if (!existsSync(file)) throw new Error(`File not found: ${file}`);
    return readFileSync(file, 'utf8');
  }
  if (query) return query;
  if (!process.stdin.isTTY) return readFileSync(0, 'utf8');
  throw new Error('Pass a query as an argument, with -f <file>, or on stdin.');
}

async function fieldsForQuery(session: Session, query: string): Promise<Field[] | undefined> {
  const prefix = sourcePrefix(query);
  return prefix ? session.columnsFor(prefix) : undefined;
}

export interface QueryOptions extends CommonOptions {
  file?: string;
  format?: OutputFormat;
  param?: string[];
  async?: boolean;
  dropNullColumns?: boolean;
  profilePlan?: boolean;
  noLint?: boolean;
  discover?: boolean;
  width?: number;
}

export async function queryCommand(queryArg: string | undefined, options: QueryOptions): Promise<number> {
  const p = painterFor(options);
  const query = readQueryInput(queryArg, options.file).trim();
  const session = await openSession(options);
  const format = options.format ?? (session.config.format as OutputFormat | undefined) ?? (process.stdout.isTTY ? 'table' : 'json');

  if (!options.noLint) {
    const fields = await fieldsForQuery(session, query);
    const lint = lintQuery(query, { fields, config: session.lintConfig });
    const blocking = lint.diagnostics.filter((d) => d.severity === 'error');
    if (blocking.length) {
      console.error(renderDiagnostics(query, blocking, 'text', p));
      console.error(p.muted('\nQuery not sent. Use --no-lint to send it anyway.'));
      return 2;
    }
    const warnings = lint.diagnostics.filter((d) => d.severity === 'warning');
    if (warnings.length && process.stderr.isTTY) console.error(renderDiagnostics(query, warnings, 'text', p) + '\n');
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);
  try {
    const res = await runEsql(session.transport, {
      query,
      params: options.param ? parseParams(options.param) : undefined,
      async: options.async,
      dropNullColumns: options.dropNullColumns,
      profile: options.profilePlan,
      signal: controller.signal,
    });
    const width = options.width ?? (process.stdout.isTTY ? process.stdout.columns : undefined);
    console.log(renderResult(res, format, { painter: format === 'table' && p.enabled ? p : undefined, maxWidth: width }));
    if (options.profilePlan && res.profile) console.error(JSON.stringify(res.profile, null, 2));
    if (options.discover && session.transport.kibanaUrl) console.error(p.muted(`Open in Discover: ${discoverLink(session.transport.kibanaUrl, query, session.transport.space)}`));
    return 0;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

export interface LintCommandOptions extends CommonOptions {
  format?: LintFormat;
  fix?: boolean;
  write?: boolean;
  maxWarnings?: number;
}

export async function lintCommand(targets: string[], options: LintCommandOptions): Promise<number> {
  const p = painterFor(options);
  const inputs: Array<{ file: string; text: string }> = [];
  if (!targets.length) inputs.push({ file: '<stdin>', text: readQueryInput(undefined, '-') });
  for (const t of targets) {
    if (existsSync(t)) inputs.push({ file: t, text: readFileSync(t, 'utf8') });
    else inputs.push({ file: '<query>', text: t });
  }

  let session: Session | undefined;
  if (!options.offline) {
    try {
      session = await openSession(options);
    } catch (err) {
      if (!options.demo && options.offline === undefined) console.error(p.muted(`Linting without a cluster (${(err as Error).message.split('.')[0]}). Column checks are skipped.`));
    }
  }
  const lintConfig = session?.lintConfig ?? loadConfig().lint ?? {};

  let exit = 0;
  const outputs: string[] = [];
  const sarifFiles: Array<{ file: string; diagnostics: ReturnType<typeof lintQuery>['diagnostics'] }> = [];
  for (const input of inputs) {
    let text = input.text.replace(/\s+$/, '');
    if (options.fix) {
      const fixed = formatQuery(text, { functionCase: lintConfig.functionCase });
      if (!fixed.error) text = fixed.text;
      if (options.write && input.file !== '<query>' && input.file !== '<stdin>') writeFileSync(input.file, text + '\n');
      else if (!options.write && inputs.length === 1 && options.format !== 'json') console.log(text + '\n');
    }
    const fields = session ? await fieldsForQuery(session, text) : undefined;
    const result = lintQuery(text, { fields, config: lintConfig });
    if (options.format === 'sarif') sarifFiles.push({ file: input.file, diagnostics: result.diagnostics });
    else outputs.push(renderDiagnostics(text, result.diagnostics, options.format ?? 'text', p, input.file));
    if (result.errorCount) exit = 1;
    if (options.maxWarnings !== undefined && result.warningCount > options.maxWarnings) exit = 1;
  }
  if (options.format === 'sarif') {
    const { toSarif } = await import('../render/diagnostics.js');
    console.log(JSON.stringify(toSarif(sarifFiles), null, 2));
  } else console.log(outputs.join('\n\n'));
  return exit;
}

export interface FmtOptions extends CommonOptions {
  check?: boolean;
  write?: boolean;
  wrap?: number;
  inline?: boolean;
}

export function fmtCommand(targets: string[], options: FmtOptions): number {
  const p = painterFor(options);
  const lintConfig = loadConfig().lint ?? {};
  const inputs = targets.length ? targets.map((t) => ({ file: existsSync(t) ? t : undefined, text: existsSync(t) ? readFileSync(t, 'utf8') : t })) : [{ file: undefined, text: readQueryInput(undefined, '-') }];
  let changed = 0;
  for (const input of inputs) {
    const result = formatQuery(input.text, { wrap: options.wrap, inline: options.inline, functionCase: lintConfig.functionCase });
    if (result.error) {
      console.error(p.err(`${input.file ?? '<query>'}: cannot format, ${result.error}`));
      return 1;
    }
    if (result.changed) changed++;
    if (options.check) {
      if (result.changed) console.log(`${p.warn('would reformat')} ${input.file ?? '<query>'}`);
    } else if (options.write && input.file) {
      if (result.changed) writeFileSync(input.file, result.text + '\n');
      console.log(`${result.changed ? p.accent('formatted') : p.muted('unchanged')} ${input.file}`);
    } else console.log(result.text);
  }
  return options.check && changed ? 1 : 0;
}

export interface CompleteOptions extends CommonOptions {
  query?: string;
  cursor?: number;
  format?: 'json' | 'plain' | 'rich';
  limit?: number;
}

export async function completeCommand(options: CompleteOptions): Promise<number> {
  const p = painterFor(options);
  const text = options.query ?? readQueryInput(undefined, '-').replace(/\n$/, '');
  const offset = options.cursor ?? text.length;
  let schema: Parameters<typeof complete>[0]['schema'] = {};
  if (!options.offline) {
    try {
      const session = await openSession(options);
      const prefix = pipelinePrefix(text, offset);
      const [columns, sources, policies, lookups] = await Promise.all([
        prefix ? session.columnsFor(prefix) : fieldsForQuery(session, text),
        session.schema.listSources().catch(() => undefined),
        session.schema.listPolicies().catch(() => undefined),
        session.schema.listLookupIndices().catch(() => undefined),
      ]);
      schema = { columns, sources, policies, lookupIndices: lookups };
    } catch {
      /* static completion only */
    }
  }
  const result = complete({ text, offset, schema, limit: options.limit ?? 30 });
  if (options.format === 'json' || (!options.format && !process.stdout.isTTY)) {
    console.log(JSON.stringify(result, null, 2));
  } else if (options.format === 'plain') {
    console.log(result.suggestions.map((s) => s.label).join('\n'));
  } else {
    console.log(p.muted(`context: ${result.context}`));
    for (const s of result.suggestions) {
      console.log(`${p.hex(elastic.teal)(KIND_GLYPHS[s.kind])} ${p.c.bold(s.label.padEnd(28))} ${p.muted(s.detail ?? '')}`);
    }
  }
  return 0;
}

export async function schemaCommand(what: 'indices' | 'fields' | 'policies' | 'lookups' | 'dataviews' | 'refresh', arg: string | undefined, options: CommonOptions): Promise<number> {
  const p = painterFor(options);
  const session = await openSession(options);
  switch (what) {
    case 'indices': {
      const names = await session.schema.listSources();
      const re = arg ? new RegExp(`^${arg.replace(/\*/g, '.*')}$`) : undefined;
      console.log(names.filter((n) => !re || re.test(n)).join('\n'));
      break;
    }
    case 'fields': {
      if (!arg) throw new Error('Usage: kibanaut schema fields <index-pattern-or-query>');
      const prefix = /^\s*(FROM|TS|ROW)\b/i.test(arg) ? arg : `FROM ${arg}`;
      const fields = await session.schema.columnsFor(prefix);
      const w = Math.max(...fields.map((f) => f.name.length), 4);
      for (const f of fields) console.log(`${f.name.padEnd(w)}  ${p.muted(f.type)}`);
      break;
    }
    case 'policies':
      console.log((await session.schema.listPolicies()).join('\n'));
      break;
    case 'lookups':
      console.log((await session.schema.listLookupIndices()).join('\n'));
      break;
    case 'dataviews': {
      const views = (await session.schema.listDataViews?.()) ?? [];
      for (const v of views) console.log(`${v.name.padEnd(32)}  ${p.muted(v.title)}`);
      break;
    }
    case 'refresh':
      session.schema.clear?.();
      console.log('Schema cache cleared.');
      break;
  }
  return 0;
}

export function docsCommand(name: string | undefined, options: CommonOptions & { search?: boolean }): number {
  const p = painterFor(options);
  if (!name) {
    console.log('Usage: kibanaut docs <FUNCTION|COMMAND>  or  kibanaut docs --search <text>');
    return 1;
  }
  if (options.search) {
    console.log(searchDocs(name).join('\n'));
    return 0;
  }
  const doc = lookupDoc(name);
  if (!doc) {
    const near = searchDocs(name).slice(0, 8);
    console.error(p.err(`No docs for "${name}".`) + (near.length ? p.muted(` Did you mean: ${near.join(', ')}`) : ''));
    return 1;
  }
  console.log(`${p.hex(elastic.teal).bold(doc.title)} ${p.muted(doc.kind)}`);
  console.log(doc.summary);
  if (doc.signatures.length) {
    console.log('');
    for (const s of doc.signatures) console.log(`  ${p.hex(elastic.blue)(s)}`);
  }
  if (doc.examples.length) {
    console.log('');
    for (const e of doc.examples) console.log(`  ${p.hex(elastic.yellow)(e)}`);
  }
  if (doc.notes.length) console.log('\n' + doc.notes.map((n) => p.muted(n)).join('\n'));
  return 0;
}

export async function configCommand(action: string | undefined, args: string[], options: CommonOptions): Promise<number> {
  const p = painterFor(options);
  const config = loadConfig();
  switch (action ?? 'list') {
    case 'list': {
      const names = Object.keys(config.profiles);
      if (!names.length) {
        console.log(p.muted('No profiles. Run `kibanaut init`.'));
        return 0;
      }
      for (const name of names) {
        const pr = config.profiles[name];
        const marker = name === config.currentProfile ? p.accent('●') : ' ';
        console.log(`${marker} ${p.c.bold(name.padEnd(16))} ${pr.via === 'es' ? pr.esUrl : pr.kibanaUrl}${pr.space ? p.muted(` space=${pr.space}`) : ''}${pr.esVersion ? p.muted(` es=${pr.esVersion}`) : ''}`);
      }
      return 0;
    }
    case 'use': {
      const name = args[0];
      if (!name || !config.profiles[name]) throw new Error(`Unknown profile "${name ?? ''}"`);
      saveConfig({ ...config, currentProfile: name });
      console.log(`Now using ${p.accent(name)}`);
      return 0;
    }
    case 'remove': {
      const name = args[0];
      if (!name || !config.profiles[name]) throw new Error(`Unknown profile "${name ?? ''}"`);
      const { [name]: _removed, ...rest } = config.profiles;
      const next: Config = { ...config, profiles: rest, currentProfile: config.currentProfile === name ? Object.keys(rest)[0] : config.currentProfile };
      saveConfig(next);
      await (await createSecretStore()).delete(name);
      console.log(`Removed ${name}`);
      return 0;
    }
    case 'set': {
      const [key, value] = args;
      if (!key || value === undefined) throw new Error('Usage: kibanaut config set <key> <value>  (keys: format, schemaTtlSeconds, functionCase)');
      const next: Config = { ...config };
      if (key === 'format') next.format = value;
      else if (key === 'schemaTtlSeconds') next.schemaTtlSeconds = Number(value);
      else if (key === 'functionCase') next.lint = { ...next.lint, functionCase: value as 'upper' | 'lower' | 'ignore' };
      else throw new Error(`Unknown key ${key}`);
      saveConfig(next);
      console.log(`${key} = ${value}`);
      return 0;
    }
    case 'path':
      console.log(configPath());
      return 0;
    case 'rules':
      for (const r of RULES) console.log(`${p.c.bold(r.meta.code)} ${r.meta.name.padEnd(30)} ${p.sev(r.meta.severity)(r.meta.severity.padEnd(8))} ${r.meta.summary}${r.meta.fixable ? p.muted(' (fixable)') : ''}`);
      return 0;
    default:
      throw new Error(`Unknown config action "${action}". Try: list, use, remove, set, path, rules`);
  }
}

export function completionScript(shell: string): string {
  switch (shell) {
    case 'zsh':
      return `#compdef kibanaut kq
# kibanaut zsh completion. Completes subcommands, flags, profiles, indices, and ES|QL inside --query.
_kibanaut() {
  local -a subcmds
  subcmds=(init query lint fmt complete schema docs config completion)
  if (( CURRENT == 2 )); then
    _describe 'command' subcmds
    return
  fi
  case "$words[2]" in
    query|lint|complete)
      if [[ "$words[CURRENT-1]" == "--profile" ]]; then
        local -a profiles; profiles=(\${(f)"$(kibanaut config list 2>/dev/null | awk '{print $2}')"})
        _describe 'profile' profiles; return
      fi
      if [[ "$words[CURRENT-1]" == "-q" || "$words[CURRENT-1]" == "--query" ]]; then
        local -a sugg; sugg=(\${(f)"$(kibanaut complete --format plain --query "$words[CURRENT]" 2>/dev/null)"})
        compadd -Q -S '' -- $sugg; return
      fi
      _arguments '--profile[profile]:profile:' '--format[output format]:format:(table json ndjson csv tsv md)' '-f[file]:file:_files' '--async' '--no-lint' '--demo' '*:file:_files'
      ;;
    schema) _values 'what' indices fields policies lookups dataviews refresh ;;
    config) _values 'action' list use remove set path rules ;;
    completion) _values 'shell' bash zsh fish ;;
    *) _files ;;
  esac
}
_kibanaut "$@"`;
    case 'bash':
      return `# kibanaut bash completion
_kibanaut() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"; prev="\${COMP_WORDS[COMP_CWORD-1]}"
  if [[ $COMP_CWORD -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "init query lint fmt complete schema docs config completion" -- "$cur") ); return
  fi
  case "$prev" in
    --profile) COMPREPLY=( $(compgen -W "$(kibanaut config list 2>/dev/null | awk '{print $2}')" -- "$cur") ); return ;;
    --format) COMPREPLY=( $(compgen -W "table json ndjson csv tsv md" -- "$cur") ); return ;;
    -q|--query) COMPREPLY=( $(kibanaut complete --format plain --query "$cur" 2>/dev/null) ); return ;;
    schema) COMPREPLY=( $(compgen -W "indices fields policies lookups dataviews refresh" -- "$cur") ); return ;;
    config) COMPREPLY=( $(compgen -W "list use remove set path rules" -- "$cur") ); return ;;
    completion) COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ); return ;;
  esac
  COMPREPLY=( $(compgen -f -- "$cur") )
}
complete -F _kibanaut kibanaut kq`;
    case 'fish':
      return `# kibanaut fish completion
complete -c kibanaut -f
complete -c kibanaut -n '__fish_use_subcommand' -a 'init query lint fmt complete schema docs config completion'
complete -c kibanaut -n '__fish_seen_subcommand_from query lint complete' -l profile -x -a '(kibanaut config list 2>/dev/null | awk \\'{print $2}\\')'
complete -c kibanaut -n '__fish_seen_subcommand_from query' -l format -x -a 'table json ndjson csv tsv md'
complete -c kibanaut -n '__fish_seen_subcommand_from query lint complete' -s q -l query -x -a '(kibanaut complete --format plain --query (commandline -ct) 2>/dev/null)'
complete -c kibanaut -n '__fish_seen_subcommand_from schema' -x -a 'indices fields policies lookups dataviews refresh'
complete -c kibanaut -n '__fish_seen_subcommand_from config' -x -a 'list use remove set path rules'
complete -c kibanaut -n '__fish_seen_subcommand_from completion' -x -a 'bash zsh fish'
complete -c kq -w kibanaut`;
    default:
      throw new Error(`Unsupported shell "${shell}". Use bash, zsh, or fish.`);
  }
}

export function explainTransportError(err: unknown, p: Painter): string {
  if (err instanceof TransportError) {
    if (err.status === 401) return `${p.err('Authentication failed (401).')} Re-run \`kibanaut init\` or check KIBANAUT_API_KEY.`;
    if (err.status === 403) return `${p.err('Forbidden (403).')} The key lacks privileges for this request: ${err.message}`;
    if (err.status === 404) return `${p.err('Not found (404).')} ${err.message}`;
    return `${p.err(err.status ? `HTTP ${err.status}:` : 'Request failed:')} ${err.message}`;
  }
  return p.err((err as Error).message);
}
