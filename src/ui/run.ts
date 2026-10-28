import { EventEmitter } from 'node:events';
import chalk from 'chalk';
import { render } from 'ink';
import React from 'react';
import type { Session } from '../commands/session.js';
import { App, type AppProps } from './app.js';
import { History } from './history.js';
import { createPainter } from './theme.js';

export interface LaunchOptions {
  session: Session;
  initialText?: string;
  autorun?: boolean;
  color?: boolean;
}

export async function launchTui(options: LaunchOptions): Promise<void> {
  const painter = createPainter({ color: options.color });
  const history = new History();
  const stdout = process.stdout;
  stdout.write('\u001b[?1049h\u001b[H');
  const instance = render(
    React.createElement(App, { session: options.session, painter, history, initialText: options.initialText, autorun: options.autorun }),
    { exitOnCtrlC: false, patchConsole: false, kittyKeyboard: { mode: 'auto', flags: ['disambiguateEscapeCodes'] } },
  );
  try {
    await instance.waitUntilExit();
  } finally {
    instance.unmount();
    stdout.write('\u001b[?1049l');
  }
}

/** A stdout stand-in that records every frame Ink writes. */
class FrameRecorder extends EventEmitter {
  frames: string[] = [];
  isTTY = true;
  constructor(public columns: number, public rows: number) {
    super();
  }
  write(chunk: string): boolean {
    this.frames.push(chunk);
    return true;
  }
  get lastFrame(): string {
    return this.frames[this.frames.length - 1] ?? '';
  }
}

export interface CaptureOptions extends Omit<AppProps, 'painter' | 'history' | 'size'> {
  columns?: number;
  rows?: number;
  /** How long to let effects (lint, completion, autorun) settle. */
  settleMs?: number;
}

/** Renders the app headlessly and returns the final ANSI frame. */
export async function captureFrame(options: CaptureOptions): Promise<string> {
  const { columns = 110, rows = 34, settleMs = 400, ...props } = options;
  const recorder = new FrameRecorder(columns, rows);
  // Ink colors borders through the shared default chalk instance; make it truecolor for captures.
  chalk.level = 3;
  const stdin = Object.assign(new EventEmitter(), { isTTY: true, setRawMode: () => undefined, setEncoding: () => undefined, resume: () => undefined, pause: () => undefined, ref: () => undefined, unref: () => undefined, read: () => null }) as unknown as NodeJS.ReadStream;
  const painter = createPainter({ level: 3 });
  const history = new History(undefined, false);
  const instance = render(React.createElement(App, { ...props, painter, history, size: { columns, rows } }), {
    stdout: recorder as unknown as NodeJS.WriteStream,
    stdin,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });
  await new Promise((r) => setTimeout(r, settleMs));
  const frame = recorder.lastFrame;
  instance.unmount();
  return frame;
}
