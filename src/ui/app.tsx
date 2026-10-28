import { writeFileSync } from 'node:fs';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { explainTransportError } from '../commands/cli.js';
import { sourcePrefix, type Session } from '../commands/session.js';
import { complete, pipelinePrefix } from '../core/complete.js';
import { formatQuery } from '../core/format.js';
import { lintQuery } from '../core/lint/index.js';
import { wordBefore } from '../core/tokenize.js';
import type { Diagnostic, Field, Suggestion } from '../core/types.js';
import { renderResult } from '../render/formats.js';
import { runEsql, type EsqlResponse } from '../transport/index.js';
import { discoverLink } from '../transport/schema.js';
import { CompletionPopup, DiagnosticsStrip, EditorView, Header, HelpView, RecordView, ResultsView, StatusBar, stripAnsi } from './components.js';
import {
  backspace,
  deleteWordBackward,
  insert,
  insertPipe,
  killToLineEnd,
  lineColumn,
  lineEnd,
  lineStart,
  looksRunnable,
  moveHorizontal,
  moveVertical,
  moveWord,
  replaceRange,
  type EditorState,
} from './editor-model.js';
import type { History } from './history.js';
import { elastic, type Painter } from './theme.js';

export interface AppProps {
  session: Session;
  painter: Painter;
  history: History;
  initialText?: string;
  initialCursor?: number;
  /** Run the initial query as soon as the app mounts (snapshots, `--run`). */
  autorun?: boolean;
  /** Open the completion popup on mount (snapshots). */
  openCompletion?: boolean;
  /** Start in the record view once results arrive (snapshots). */
  initialRecord?: boolean;
  /** Fixed size instead of the terminal size (snapshots). */
  size?: { columns: number; rows: number };
  onExit?: () => void;
}

interface CompletionState {
  open: boolean;
  items: Suggestion[];
  index: number;
  replaceStart: number;
  replaceEnd: number;
  context: string;
}

interface StatusMessage {
  kind: 'info' | 'ok' | 'error';
  text: string;
}

const CLOSED: CompletionState = { open: false, items: [], index: 0, replaceStart: 0, replaceEnd: 0, context: '' };

export function App({ session, painter: p, history, initialText = '', initialCursor, autorun, openCompletion, initialRecord, size, onExit }: AppProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [dims, setDims] = useState(size ?? { columns: stdout.columns || 100, rows: stdout.rows || 30 });
  const [ed, setEd] = useState<EditorState>({ text: initialText, cursor: initialCursor ?? initialText.length });
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [completion, setCompletion] = useState<CompletionState>(CLOSED);
  const [result, setResult] = useState<EsqlResponse | undefined>();
  const [resultTitle, setResultTitle] = useState<string | undefined>();
  const [scroll, setScroll] = useState(0);
  const [selectedRow, setSelectedRow] = useState(0);
  const [record, setRecord] = useState(Boolean(initialRecord));
  const [help, setHelp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<StatusMessage | undefined>();
  const [historyIndex, setHistoryIndex] = useState<number | undefined>();
  const schemaRef = useRef<{ sources?: string[]; policies?: string[]; lookups?: string[]; columns: Map<string, Field[]> }>({ columns: new Map() });
  const edRef = useRef(ed);
  edRef.current = ed;
  const completionRef = useRef(completion);
  completionRef.current = completion;
  const lintSeq = useRef(0);

  useEffect(() => {
    if (size) return;
    const onResize = () => setDims({ columns: stdout.columns || 100, rows: stdout.rows || 30 });
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout, size]);

  const fetchColumns = useCallback(
    async (prefix: string): Promise<Field[] | undefined> => {
      const cached = schemaRef.current.columns.get(prefix);
      if (cached) return cached;
      const fields = await session.columnsFor(prefix);
      if (fields) schemaRef.current.columns.set(prefix, fields);
      return fields;
    },
    [session],
  );

  // Prefetch cluster metadata once; everything stays usable if it fails.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [sources, policies, lookups] = await Promise.all([
        session.schema.listSources().catch(() => undefined),
        session.schema.listPolicies().catch(() => undefined),
        session.schema.listLookupIndices().catch(() => undefined),
      ]);
      if (cancelled) return;
      schemaRef.current.sources = sources;
      schemaRef.current.policies = policies;
      schemaRef.current.lookups = lookups;
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  // Live lint, debounced.
  useEffect(() => {
    const seq = ++lintSeq.current;
    const timer = setTimeout(async () => {
      const text = ed.text;
      if (!text.trim()) {
        setDiagnostics([]);
        return;
      }
      const prefix = sourcePrefix(text);
      const fields = prefix ? await fetchColumns(prefix).catch(() => undefined) : undefined;
      if (seq !== lintSeq.current) return;
      const res = lintQuery(text, { fields, config: session.lintConfig });
      setDiagnostics(res.diagnostics);
    }, 120);
    return () => clearTimeout(timer);
  }, [ed.text, fetchColumns, session.lintConfig]);

  const refreshCompletion = useCallback(
    (state: EditorState, force: boolean) => {
      const prefix = pipelinePrefix(state.text, state.cursor) ?? sourcePrefix(state.text);
      const base = sourcePrefix(state.text);
      const columns = prefix ? schemaRef.current.columns.get(prefix) : undefined;
      const baseFields = base ? schemaRef.current.columns.get(base) : undefined;
      const res = complete({
        text: state.text,
        offset: state.cursor,
        schema: { columns, baseFields, sources: schemaRef.current.sources, policies: schemaRef.current.policies, lookupIndices: schemaRef.current.lookups },
        limit: 40,
      });
      const { word } = wordBefore(state.text, state.cursor);
      const open = res.suggestions.length > 0 && (force || word.length >= 1);
      setCompletion({ open, items: res.suggestions, index: 0, replaceStart: res.replaceStart, replaceEnd: res.replaceEnd, context: res.context });
      if (prefix && !columns) {
        fetchColumns(prefix)
          .then((fields) => {
            if (fields && completionRef.current.open && edRef.current === state) refreshCompletion(state, force);
          })
          .catch(() => undefined);
      }
    },
    [fetchColumns],
  );

  const showResult = useCallback((res: EsqlResponse, title?: string) => {
    setResult(res);
    setResultTitle(title);
    setScroll(0);
    setSelectedRow(0);
  }, []);

  const runQuery = useCallback(
    async (text: string) => {
      setBusy(true);
      setStatus({ kind: 'info', text: 'running…' });
      try {
        const res = await runEsql(session.transport, { query: text });
        showResult(res);
        setStatus({ kind: 'ok', text: `${res.values.length} row${res.values.length === 1 ? '' : 's'}${res.took !== undefined ? ` in ${res.took} ms` : ''}` });
        history.add(text, session.profile.name);
        setHistoryIndex(undefined);
      } catch (err) {
        setStatus({ kind: 'error', text: stripAnsi(explainTransportError(err, p)) });
      } finally {
        setBusy(false);
      }
    },
    [session, history, p, showResult],
  );

  const quit = useCallback(() => {
    onExit?.();
    exit();
  }, [exit, onExit]);

  const runMeta = useCallback(
    async (line: string) => {
      const [cmd, ...rest] = line.trim().slice(1).split(/\s+/);
      const arg = rest.join(' ');
      try {
        switch (cmd) {
          case 'q':
            quit();
            break;
          case 'h':
            setHelp((h) => !h);
            break;
          case 'x':
            setRecord((r) => !r);
            break;
          case 'c':
            setResult(undefined);
            setStatus(undefined);
            break;
          case 'f': {
            const f = formatQuery(edRef.current.text, { functionCase: session.lintConfig.functionCase });
            if (!f.error) setEd({ text: f.text, cursor: f.text.length });
            break;
          }
          case 'i': {
            setBusy(true);
            const names = await session.schema.listSources();
            const re = arg ? new RegExp(`^${arg.replace(/\*/g, '.*')}$`) : undefined;
            const rows = names.filter((n) => !re || re.test(n));
            showResult({ columns: [{ name: 'index', type: 'keyword' }], values: rows.map((n) => [n]) }, `indices${arg ? ` matching ${arg}` : ''}`);
            break;
          }
          case 'd': {
            if (!arg) {
              setStatus({ kind: 'error', text: 'usage: \\d <index-pattern>' });
              break;
            }
            setBusy(true);
            const fields = await session.schema.columnsFor(`FROM ${arg}`);
            showResult({ columns: [{ name: 'field', type: 'keyword' }, { name: 'type', type: 'keyword' }], values: fields.map((f) => [f.name, f.type]) }, `fields of ${arg}`);
            break;
          }
          case 'p': {
            setBusy(true);
            const policies = await session.schema.listPolicies();
            showResult({ columns: [{ name: 'policy', type: 'keyword' }], values: policies.map((n) => [n]) }, 'enrich policies');
            break;
          }
          default:
            setStatus({ kind: 'error', text: `unknown meta command \\${cmd}; try \\h` });
        }
      } catch (err) {
        setStatus({ kind: 'error', text: stripAnsi(explainTransportError(err, p)) });
      } finally {
        setBusy(false);
      }
    },
    [quit, session, showResult, p],
  );

  const submit = useCallback(() => {
    const text = edRef.current.text.trim();
    if (!text) return;
    if (text.startsWith('\\')) {
      void runMeta(text);
      setEd({ text: '', cursor: 0 });
      return;
    }
    if (diagnostics.some((d) => d.severity === 'error')) {
      setStatus({ kind: 'error', text: `fix the ${diagnostics.filter((d) => d.severity === 'error').length} error(s) first, or run anyway with ^r` });
      return;
    }
    void runQuery(text);
  }, [diagnostics, runMeta, runQuery]);

  useEffect(() => {
    if (autorun && initialText.trim()) void runQuery(initialText.trim());
    if (openCompletion) {
      const state = { text: initialText, cursor: initialCursor ?? initialText.length };
      refreshCompletion(state, true);
      const prefix = pipelinePrefix(state.text, state.cursor) ?? sourcePrefix(state.text);
      if (prefix) fetchColumns(prefix).then(() => refreshCompletion(state, true)).catch(() => undefined);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const acceptCompletion = useCallback(() => {
    const c = completionRef.current;
    const item = c.items[c.index];
    if (!item) return;
    const next = replaceRange(edRef.current, c.replaceStart, c.replaceEnd, item.insertText, item.cursorDelta ?? 0);
    setEd(next);
    setCompletion(CLOSED);
    if (item.kind === 'command') setTimeout(() => refreshCompletion(next, true), 0);
  }, [refreshCompletion]);

  const update = useCallback(
    (next: EditorState, typed?: string) => {
      setEd(next);
      setHistoryIndex(undefined);
      const c = completionRef.current;
      if (typed !== undefined && /[A-Za-z0-9_@.*]/.test(typed)) refreshCompletion(next, false);
      else if (c.open && typed !== undefined) refreshCompletion(next, false);
      else if (c.open) setCompletion(CLOSED);
    },
    [refreshCompletion],
  );

  useInput((input, key) => {
    if (key.ctrl && (input === 'q' || input === 'c')) return quit();
    if (key.ctrl && input === 'd' && !ed.text) return quit();
    if (help) {
      if (key.escape || input === 'q' || input === '?' || key.return) setHelp(false);
      return;
    }
    const c = completionRef.current;
    if (c.open) {
      if (key.upArrow) return setCompletion({ ...c, index: (c.index - 1 + c.items.length) % c.items.length });
      if (key.downArrow) return setCompletion({ ...c, index: (c.index + 1) % c.items.length });
      if (key.tab || (key.return && !key.meta)) return acceptCompletion();
      if (key.escape) return setCompletion(CLOSED);
    } else if (key.tab) {
      return refreshCompletion(ed, true);
    } else if (key.escape) {
      setStatus(undefined);
      return;
    }

    if (record && result) {
      if (key.upArrow) return setSelectedRow((r) => Math.max(0, r - 1));
      if (key.downArrow) return setSelectedRow((r) => Math.min(result.values.length - 1, r + 1));
    }

    if (key.return) {
      if (key.meta) return update(insert(ed, '\n'));
      if (busy) return;
      if (looksRunnable(ed.text) || ed.text.trim().startsWith('\\')) return submit();
      return update(insert(ed, '\n'));
    }
    if (key.ctrl && input === 'r') {
      if (!busy && ed.text.trim()) void runQuery(ed.text.trim());
      return;
    }
    if (key.backspace || key.delete) {
      if (key.meta || key.ctrl) return update(deleteWordBackward(ed), '');
      return update(backspace(ed), '');
    }
    if (key.leftArrow) return update(key.meta || key.ctrl ? moveWord(ed, -1) : moveHorizontal(ed, -1));
    if (key.rightArrow) return update(key.meta || key.ctrl ? moveWord(ed, 1) : moveHorizontal(ed, 1));
    if (key.home || (key.ctrl && input === 'a')) return update(lineStart(ed));
    if (key.end || (key.ctrl && input === 'e')) {
      if (key.end || !result) return update(lineEnd(ed));
      if (key.ctrl && input === 'e') {
        const file = `kibanaut-results-${Date.now()}.csv`;
        writeFileSync(file, renderResult(result, 'csv') + '\n');
        return setStatus({ kind: 'ok', text: `exported ${result.values.length} rows to ${file}` });
      }
    }
    if (key.upArrow || key.downArrow) {
      const moved = moveVertical(ed, key.upArrow ? -1 : 1);
      if (moved) return update(moved);
      const entries = history.all();
      if (!entries.length) return;
      let idx = historyIndex ?? entries.length;
      idx = key.upArrow ? Math.max(0, idx - 1) : Math.min(entries.length, idx + 1);
      const text = idx === entries.length ? '' : entries[idx].query;
      setEd({ text, cursor: text.length });
      setHistoryIndex(idx === entries.length ? undefined : idx);
      setCompletion(CLOSED);
      return;
    }
    if (key.pageUp || key.pageDown) {
      if (!result) return;
      const page = Math.max(1, resultsHeight - 6);
      setScroll((s) => Math.max(0, Math.min(Math.max(0, result.values.length - page), s + (key.pageDown ? page : -page))));
      return;
    }
    if (key.ctrl && input === 'f') {
      const f = formatQuery(ed.text, { functionCase: session.lintConfig.functionCase });
      if (f.error) return setStatus({ kind: 'error', text: `cannot format: ${f.error}` });
      return update({ text: f.text, cursor: f.text.length });
    }
    if (key.ctrl && input === 'x') return setRecord((r) => !r);
    if (key.ctrl && input === 'o') {
      if (!session.transport.kibanaUrl) return setStatus({ kind: 'error', text: 'no Kibana URL in this profile' });
      return setStatus({ kind: 'info', text: discoverLink(session.transport.kibanaUrl, ed.text, session.transport.space) });
    }
    if (key.ctrl && input === 's') {
      const file = `kibanaut-${Date.now()}.esql`;
      writeFileSync(file, ed.text.trim() + '\n');
      return setStatus({ kind: 'ok', text: `saved query to ${file}` });
    }
    if (key.ctrl && input === 'u') return update({ text: '', cursor: 0 });
    if (key.ctrl && input === 'w') return update(deleteWordBackward(ed), '');
    if (key.ctrl && input === 'k') return update(killToLineEnd(ed), '');
    if (key.ctrl && input === 'l') {
      setResult(undefined);
      return setStatus(undefined);
    }
    if (input === '?' && !ed.text) return setHelp(true);
    if (key.ctrl || key.meta) return;
    if (input === '|') return update(insertPipe(ed), '|');
    if (input) return update(insert(ed, input), input);
  });

  const visibleDiagnostics = useMemo(
    () => (completion.open ? diagnostics.filter((d) => !(d.start <= ed.cursor && ed.cursor <= d.end)) : diagnostics),
    [diagnostics, completion.open, ed.cursor],
  );
  const width = dims.columns;
  const innerWidth = Math.max(20, width - 4);
  const editorLines = ed.text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil((line.length + 7) / innerWidth)), 0);
  const editorHeight = editorLines + 2;
  const diagHeight = Math.min(visibleDiagnostics.length, 3) + (visibleDiagnostics.length > 3 ? 1 : 0);
  const popupHeight = completion.open ? Math.min(completion.items.length, 8) + 3 + (completion.items[completion.index]?.documentation ? 1 : 0) : 0;
  const resultsHeight = Math.max(6, dims.rows - 1 - editorHeight - diagHeight - popupHeight - 1);
  const { column } = lineColumn(ed.text, completion.replaceStart);
  const popupMargin = Math.min(Math.max(0, width - 60), 6 + column);

  const statusLeft = useMemo(() => {
    if (status) {
      const paint = status.kind === 'error' ? p.err : status.kind === 'ok' ? p.ok : p.muted;
      return paint(status.text.replace(/\s+/g, ' ').slice(0, Math.max(10, width - 40)));
    }
    const hasErrors = diagnostics.some((d) => d.severity === 'error');
    const hint = completion.open ? `completing ${completion.context}` : record ? 'record view' : hasErrors ? 'fix the errors, or ^r runs anyway' : looksRunnable(ed.text) ? 'enter to run' : ed.text.trim() ? 'finish the pipeline, then enter' : 'type a query, tab for completion, ? for help';
    return p.muted(hint);
  }, [status, completion, record, ed.text, p, width, diagnostics]);

  const errors = diagnostics.filter((d) => d.severity === 'error').length;
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length;
  const statusRight = `${errors ? p.err(`${errors} ✖ `) : ''}${warnings ? p.warn(`${warnings} ▲ `) : ''}${p.muted('tab complete · ^f format · ^x record · ^o discover · ^q quit')}`;

  return (
    <Box flexDirection="column" width={width} height={dims.rows} overflow="hidden">
      <Header p={p} info={{ profile: session.profile.name, target: session.transport.describe(), esVersion: session.profile.esVersion, demo: session.demo }} width={width} busy={busy} />
      <EditorView text={ed.text} cursor={ed.cursor} diagnostics={diagnostics} p={p} focused={!help} width={width} height={editorHeight} />
      {completion.open ? <CompletionPopup items={completion.items} index={completion.index} p={p} marginLeft={popupMargin} width={width} /> : null}
      <DiagnosticsStrip diagnostics={visibleDiagnostics} p={p} />
      {help ? (
        <HelpView p={p} width={width} height={resultsHeight} />
      ) : result ? (
        record ? (
          <RecordView res={result} row={selectedRow} height={resultsHeight} width={width} p={p} />
        ) : (
          <ResultsView res={result} scroll={scroll} height={resultsHeight} width={width} p={p} selectedRow={record ? selectedRow : undefined} title={resultTitle} />
        )
      ) : (
        <Box borderStyle="round" borderColor={p.border(elastic.darkShade)} paddingX={1} width={width} height={resultsHeight} flexDirection="column" overflow="hidden">
          <Text wrap="truncate-end">{p.muted(session.demo ? 'demo mode: sample web logs are loaded. Try: FROM logs-* | STATS c = COUNT(*) BY host.name | SORT c DESC' : 'results appear here · \\i lists indices · \\d <index> lists fields')}</Text>
        </Box>
      )}
      <StatusBar p={p} left={statusLeft} right={statusRight} width={width} />
    </Box>
  );
}
