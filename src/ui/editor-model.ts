export interface EditorState {
  text: string;
  cursor: number;
}

export function lineColumn(text: string, cursor: number): { line: number; column: number; lines: string[] } {
  const lines = text.split('\n');
  let remaining = cursor;
  for (let i = 0; i < lines.length; i++) {
    if (remaining <= lines[i].length) return { line: i, column: remaining, lines };
    remaining -= lines[i].length + 1;
  }
  return { line: lines.length - 1, column: lines[lines.length - 1].length, lines };
}

export function offsetOf(lines: string[], line: number, column: number): number {
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + Math.min(column, lines[line]?.length ?? 0);
}

export function insert(state: EditorState, s: string): EditorState {
  return { text: state.text.slice(0, state.cursor) + s + state.text.slice(state.cursor), cursor: state.cursor + s.length };
}

export function replaceRange(state: EditorState, start: number, end: number, s: string, cursorDelta = 0): EditorState {
  return { text: state.text.slice(0, start) + s + state.text.slice(end), cursor: start + s.length + cursorDelta };
}

export function backspace(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  return { text: state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor), cursor: state.cursor - 1 };
}

export function deleteForward(state: EditorState): EditorState {
  if (state.cursor >= state.text.length) return state;
  return { text: state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1), cursor: state.cursor };
}

export function deleteWordBackward(state: EditorState): EditorState {
  if (state.cursor === 0) return state;
  let i = state.cursor;
  while (i > 0 && /\s/.test(state.text[i - 1])) i--;
  while (i > 0 && !/\s/.test(state.text[i - 1])) i--;
  return { text: state.text.slice(0, i) + state.text.slice(state.cursor), cursor: i };
}

export function killToLineEnd(state: EditorState): EditorState {
  const { line, column, lines } = lineColumn(state.text, state.cursor);
  const end = offsetOf(lines, line, lines[line].length);
  if (end === state.cursor) return deleteForward(state);
  return { text: state.text.slice(0, state.cursor) + state.text.slice(end), cursor: state.cursor };
}

export function moveHorizontal(state: EditorState, delta: number): EditorState {
  return { ...state, cursor: Math.max(0, Math.min(state.text.length, state.cursor + delta)) };
}

export function moveWord(state: EditorState, direction: -1 | 1): EditorState {
  let i = state.cursor;
  const t = state.text;
  if (direction < 0) {
    while (i > 0 && /\W/.test(t[i - 1])) i--;
    while (i > 0 && /\w/.test(t[i - 1])) i--;
  } else {
    while (i < t.length && /\W/.test(t[i])) i++;
    while (i < t.length && /\w/.test(t[i])) i++;
  }
  return { ...state, cursor: i };
}

/** Moves between lines keeping the column; returns `undefined` when already on the edge line. */
export function moveVertical(state: EditorState, delta: -1 | 1): EditorState | undefined {
  const { line, column, lines } = lineColumn(state.text, state.cursor);
  const target = line + delta;
  if (target < 0 || target >= lines.length) return undefined;
  return { ...state, cursor: offsetOf(lines, target, column) };
}

export function lineStart(state: EditorState): EditorState {
  const { line, lines } = lineColumn(state.text, state.cursor);
  return { ...state, cursor: offsetOf(lines, line, 0) };
}

export function lineEnd(state: EditorState): EditorState {
  const { line, lines } = lineColumn(state.text, state.cursor);
  return { ...state, cursor: offsetOf(lines, line, lines[line].length) };
}

/**
 * Typing `|` starts a new piped command on its own line, matching the formatter's
 * output, unless the pipe is inside a string.
 */
export function insertPipe(state: EditorState): EditorState {
  const before = state.text.slice(0, state.cursor);
  const quotes = (before.match(/"/g) ?? []).length;
  if (quotes % 2 === 1) return insert(state, '|');
  const trimmed = before.replace(/[ \t]+$/, '');
  const prefix = trimmed.endsWith('\n') || trimmed === '' ? '' : '\n';
  const next = { text: trimmed + state.text.slice(state.cursor), cursor: trimmed.length };
  return insert(next, `${prefix}  | `);
}

/** True when the query looks complete enough to run on Enter (no trailing pipe or open parenthesis). */
export function looksRunnable(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (/\|\s*$/.test(trimmed)) return false;
  const opens = (trimmed.match(/\(/g) ?? []).length;
  const closes = (trimmed.match(/\)/g) ?? []).length;
  if (opens > closes) return false;
  if ((trimmed.match(/"/g) ?? []).length % 2 === 1) return false;
  return true;
}
