import { describe, expect, it } from 'vitest';
import { openSession } from '../src/commands/session.js';
import { captureFrame } from '../src/ui/run.js';
import { stripAnsi } from '../src/ui/components.js';

describe('tui', () => {
  it('renders the editor, runs a query, and shows results in demo mode', async () => {
    const session = await openSession({ demo: true });
    const frame = stripAnsi(await captureFrame({ session, initialText: 'FROM logs-* | STATS c = COUNT(*) BY host.name | SORT c DESC | LIMIT 3', autorun: true, columns: 100, rows: 24, settleMs: 600 }));
    expect(frame).toContain('kibanaut');
    expect(frame).toContain('FROM logs-*');
    expect(frame).toContain('host.name');
    expect(frame).toMatch(/3 rows/);
  });
  it('shows the completion popup and hides diagnostics under the cursor', async () => {
    const session = await openSession({ demo: true });
    const frame = stripAnsi(await captureFrame({ session, initialText: 'FROM logs-* | EVAL r = ROU', openCompletion: true, columns: 100, rows: 24, settleMs: 600 }));
    expect(frame).toContain('ROUND_TO');
    expect(frame).not.toContain('Unknown column ROU');
  });
});
