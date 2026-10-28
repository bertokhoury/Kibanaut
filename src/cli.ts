import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { completeCommand, completionScript, configCommand, docsCommand, explainTransportError, fmtCommand, lintCommand, painterFor, queryCommand, readQueryInput, schemaCommand } from './commands/cli.js';
import { runInit } from './commands/init.js';
import { NoProfileError, openSession } from './commands/session.js';
import { DEFINITIONS_ES_TAG } from './definitions/index.js';
import { ansiToSvg } from './render/ansi-svg.js';
import { OUTPUT_FORMATS, type OutputFormat } from './render/formats.js';
import { launchTui } from './ui/run.js';

const VERSION = '0.1.0';

const program = new Command();
program
  .name('kibanaut')
  .description('Pilot Kibana from a mission-control TUI: ES|QL with linting and completion built in.')
  .version(`${VERSION} (ES|QL definitions ${DEFINITIONS_ES_TAG})`)
  .option('-p, --profile <name>', 'profile to use (default: the current one)')
  .option('--demo', 'use built-in sample data instead of a cluster')
  .option('--no-color', 'disable colors')
  .argument('[query]', 'open the TUI with this query loaded')
  .option('--run', 'run the given query as soon as the TUI opens')
  .option('-f, --file <path>', 'load the query from a file')
  .action(async (query: string | undefined, opts: { profile?: string; demo?: boolean; color?: boolean; run?: boolean; file?: string }) => {
    const p = painterFor(opts);
    if (!process.stdout.isTTY) {
      console.error('kibanaut needs an interactive terminal for the TUI. Use `kibanaut query` for scripting.');
      process.exitCode = 1;
      return;
    }
    let session;
    try {
      session = await openSession({ profile: opts.profile, demo: opts.demo });
    } catch (err) {
      if (err instanceof NoProfileError) {
        console.log(p.muted('No profile yet. Starting first-run setup.\n'));
        await runInit({});
        session = await openSession({ profile: opts.profile });
      } else throw err;
    }
    const initialText = opts.file ? readQueryInput(undefined, opts.file) : query;
    await launchTui({ session, initialText, autorun: opts.run, color: opts.color });
  });

function int(value: string): number {
  const n = Number.parseInt(value, 10);
  if (Number.isNaN(n)) throw new InvalidArgumentError('Expected a number');
  return n;
}

function format(value: string): OutputFormat {
  if (!OUTPUT_FORMATS.includes(value as OutputFormat)) throw new InvalidArgumentError(`Expected one of ${OUTPUT_FORMATS.join(', ')}`);
  return value as OutputFormat;
}

program
  .command('init')
  .description('set up a profile: Kibana URL, space, and credentials stored in the OS keychain')
  .option('--profile <name>', 'profile name')
  .option('--kibana-url <url>', 'Kibana base URL')
  .option('--space <id>', 'Kibana space id')
  .option('--es-url <url>', 'direct Elasticsearch URL (optional)')
  .option('--via <transport>', 'kibana (default) or es')
  .option('--api-key <key>', 'encoded API key (prefer --api-key-stdin to keep it out of shell history)')
  .option('--api-key-stdin', 'read the API key from stdin')
  .option('--username <name>', 'username; exchanged for a scoped API key unless --no-create-api-key')
  .option('--password <secret>', 'password (prefer the interactive prompt)')
  .option('--no-create-api-key', 'store the password instead of exchanging it for an API key')
  .option('--insecure', 'skip TLS certificate verification')
  .option('--non-interactive', 'fail instead of prompting for missing values')
  .action(async (opts) => {
    await runInit({
      profile: opts.profile ?? program.opts().profile,
      kibanaUrl: opts.kibanaUrl,
      space: opts.space,
      esUrl: opts.esUrl,
      via: opts.via,
      apiKey: opts.apiKey,
      apiKeyStdin: opts.apiKeyStdin,
      username: opts.username,
      password: opts.password,
      createApiKey: opts.createApiKey,
      insecure: opts.insecure,
      nonInteractive: opts.nonInteractive,
    });
  });

program
  .command('query [query]')
  .alias('q')
  .description('run an ES|QL query and print the result (lints first)')
  .option('-f, --file <path>', 'read the query from a file (- for stdin)')
  .option('--format <format>', `output format: ${OUTPUT_FORMATS.join(', ')}`, format)
  .option('--param <name=value...>', 'named parameters for ?name placeholders')
  .option('--async', 'use the async API and poll (long queries)')
  .option('--drop-null-columns', 'omit all-null columns')
  .option('--profile-plan', 'include the execution profile on stderr')
  .option('--no-lint', 'send the query even if lint reports errors')
  .option('--discover', 'print an open-in-Discover link on stderr')
  .option('--width <columns>', 'table width', int)
  .action(async (query, opts) => {
    process.exitCode = await queryCommand(query, { ...program.opts(), ...opts });
  });

program
  .command('lint [files-or-queries...]')
  .description('lint .esql files or inline queries (reads stdin when nothing is given)')
  .option('--format <format>', 'text, json, sarif, or github')
  .option('--fix', 'apply formatting fixes (prints the fixed query, or writes with --write)')
  .option('--write', 'write fixes back to the files')
  .option('--offline', 'skip cluster lookups (no unknown-column checks)')
  .option('--max-warnings <n>', 'fail when more warnings than this', int)
  .action(async (targets, opts) => {
    process.exitCode = await lintCommand(targets, { ...program.opts(), ...opts });
  });

program
  .command('fmt [files-or-queries...]')
  .description('format queries one piped command per line')
  .option('--check', 'exit 1 if any input would change')
  .option('--write', 'rewrite files in place')
  .option('--wrap <columns>', 'wrap long commands at this width', int)
  .option('--inline', 'single-line output')
  .action((targets, opts) => {
    process.exitCode = fmtCommand(targets, { ...program.opts(), ...opts });
  });

program
  .command('complete')
  .description('suggest completions for a query at a cursor position (JSON when piped)')
  .option('-q, --query <text>', 'query text (stdin when omitted)')
  .option('--cursor <offset>', 'cursor offset (default: end of text)', int)
  .option('--format <format>', 'json, plain, or rich')
  .option('--limit <n>', 'max suggestions', int)
  .option('--offline', 'static suggestions only')
  .action(async (opts) => {
    process.exitCode = await completeCommand({ ...program.opts(), ...opts });
  });

program
  .command('schema <what> [arg]')
  .description('inspect the cluster: indices [pattern], fields <index|query>, policies, lookups, dataviews, refresh')
  .action(async (what, arg) => {
    const allowed = ['indices', 'fields', 'policies', 'lookups', 'dataviews', 'refresh'];
    if (!allowed.includes(what)) throw new InvalidArgumentError(`Expected one of ${allowed.join(', ')}`);
    process.exitCode = await schemaCommand(what, arg, program.opts());
  });

program
  .command('docs [name]')
  .description('offline reference for a function or command, e.g. `kibanaut docs DATE_TRUNC`')
  .option('--search', 'search names and descriptions instead')
  .action((name, opts) => {
    process.exitCode = docsCommand(name, { ...program.opts(), ...opts });
  });

program
  .command('config [action] [args...]')
  .description('profiles and settings: list, use <name>, remove <name>, set <key> <value>, path, rules')
  .action(async (action, args) => {
    process.exitCode = await configCommand(action, args, program.opts());
  });

program
  .command('completion <shell>')
  .description('print a shell completion script for bash, zsh, or fish')
  .action((shell) => {
    console.log(completionScript(shell));
  });

program
  .command('snapshot', { hidden: true })
  .description('render a TUI scene headlessly to an SVG (used to generate README screenshots)')
  .requiredOption('--scene <name>', 'editor, completion, results, lint, record')
  .option('--out <path>', 'write the SVG here (stdout when omitted)')
  .option('--ansi', 'emit the raw ANSI frame instead of SVG')
  .option('--columns <n>', 'terminal width', int)
  .option('--rows <n>', 'terminal height', int)
  .action(async (opts) => {
    const { captureFrame } = await import('./ui/run.js');
    const session = await openSession({ demo: true });
    const scenes: Record<string, Parameters<typeof captureFrame>[0]> = {
      editor: {
        session,
        initialText: 'FROM logs-*\n  | WHERE http.response.status_code >= 500 AND service.name LIKE "store*"\n  | EVAL duration_ms = event.duration / 1000000\n  | KEEP @timestamp, host.name, url.path, duration_ms\n  | SORT duration_ms DESC\n  | LIMIT 25',
      },
      results: {
        session,
        autorun: true,
        initialText: 'FROM logs-*\n  | WHERE http.response.status_code >= 400\n  | STATS requests = COUNT(*), p50_ms = MEDIAN(event.duration) / 1000000, bytes = SUM(bytes) BY service.name, http.response.status_code\n  | SORT requests DESC\n  | LIMIT 12',
        settleMs: 700,
      },
      completion: {
        session,
        openCompletion: true,
        initialText: 'FROM logs-*\n  | WHERE log.level == "error"\n  | STATS errors = COUNT(*) BY host.name\n  | SORT errors DESC\n  | EVAL rounded = ROU',
        settleMs: 700,
      },
      lint: {
        session,
        initialText: 'FROM logs-*\n  | WHERE http.respnse.status_code >= 500\n  | EVAL kb = bytes / 1024\n  | STATS c = COUNT(*), m = MAX(kb) BY hostname\n  | SORT c DESC',
        settleMs: 700,
      },
      record: {
        session,
        autorun: true,
        initialRecord: true,
        initialText: 'FROM logs-*\n  | WHERE http.response.status_code == 503\n  | SORT @timestamp DESC\n  | LIMIT 5',
        settleMs: 700,
      },
    };
    const scene = scenes[opts.scene];
    if (!scene) throw new InvalidArgumentError(`Unknown scene; use one of ${Object.keys(scenes).join(', ')}`);
    const frame = await captureFrame({ ...scene, columns: opts.columns ?? 110, rows: opts.rows ?? 32 });
    const output = opts.ansi ? frame : ansiToSvg(frame, { title: `kibanaut — ${opts.scene}`, columns: opts.columns ?? 110, rows: opts.rows ?? 32 });
    if (opts.out) {
      mkdirSync(dirname(opts.out), { recursive: true });
      writeFileSync(opts.out, output);
      console.error(`wrote ${opts.out}`);
    } else process.stdout.write(output);
  });

program.showHelpAfterError('(add --help for usage)');

program.parseAsync(process.argv).catch((err: unknown) => {
  const p = painterFor({ color: !process.argv.includes('--no-color') });
  const message = err instanceof NoProfileError ? err.message : explainTransportError(err, p);
  console.error(message);
  if (process.env.KIBANAUT_DEBUG && err instanceof Error) console.error(err.stack);
  process.exitCode = process.exitCode || 1;
});
