import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from '../config/config.js';

const MAX_ENTRIES = 500;

export interface HistoryEntry {
  query: string;
  at: string;
  profile: string;
}

export class History {
  private entries: HistoryEntry[] = [];
  constructor(private readonly path = join(stateDir(), 'history.jsonl'), private readonly persist = true) {
    this.load();
  }

  private load(): void {
    if (!this.persist || !existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    for (const line of lines.slice(-MAX_ENTRIES)) {
      try {
        this.entries.push(JSON.parse(line) as HistoryEntry);
      } catch {
        /* skip corrupt line */
      }
    }
  }

  all(): HistoryEntry[] {
    return this.entries;
  }

  add(query: string, profile: string): void {
    const trimmed = query.trim();
    if (!trimmed) return;
    const last = this.entries[this.entries.length - 1];
    if (last?.query === trimmed) return;
    const entry: HistoryEntry = { query: trimmed, at: new Date().toISOString(), profile };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
      if (this.persist) {
        mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
        writeFileSync(this.path, this.entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
      }
      return;
    }
    if (this.persist) {
      mkdirSync(stateDir(), { recursive: true, mode: 0o700 });
      appendFileSync(this.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
    }
  }
}
