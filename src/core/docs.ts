import { COMMANDS, getCommand } from '../definitions/commands.js';
import { formatSignature, getFunction, listFunctions } from '../definitions/index.js';

export interface DocEntry {
  title: string;
  kind: 'function' | 'command';
  summary: string;
  signatures: string[];
  examples: string[];
  notes: string[];
}

export function lookupDoc(name: string): DocEntry | undefined {
  const fn = getFunction(name);
  if (fn) {
    const notes: string[] = [];
    if (fn.preview) notes.push('Technical preview: behavior may change between releases.');
    if (fn.snapshotOnly) notes.push('Only available in snapshot builds of Elasticsearch.');
    notes.push(`Kind: ${fn.type.replace('_', ' ')}`);
    return {
      title: fn.name,
      kind: 'function',
      summary: fn.description,
      signatures: fn.signatures.map((_, i) => formatSignature(fn, i)),
      examples: fn.examples,
      notes,
    };
  }
  const cmd = getCommand(name.toLowerCase()) ?? COMMANDS.find((c) => c.name.toUpperCase() === name.toUpperCase());
  if (cmd) {
    return {
      title: cmd.name,
      kind: 'command',
      summary: cmd.summary,
      signatures: cmd.keywords.length ? [`Keywords: ${cmd.keywords.join(', ')}`] : [],
      examples: [cmd.example],
      notes: [`${cmd.kind} command`],
    };
  }
  return undefined;
}

export function searchDocs(query: string): string[] {
  const q = query.toLowerCase();
  const fns = listFunctions((f) => f.name.toLowerCase().includes(q) || f.description.toLowerCase().includes(q)).map((f) => f.name);
  const cmds = COMMANDS.filter((c) => c.name.toLowerCase().includes(q) || c.summary.toLowerCase().includes(q)).map((c) => c.name);
  return [...cmds, ...fns];
}
