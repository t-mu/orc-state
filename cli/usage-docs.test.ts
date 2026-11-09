import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { USAGE } from './usage.ts';

const DOC = readFileSync(join(import.meta.dirname, '..', 'docs', 'cli.md'), 'utf8');

/** Flags a doc row names only to say they are refused; they are not part of the command's usage. */
const NOT_FLAGS: Record<string, string[]> = { init: ['--force'] };

const FLAG_RE = /--[a-z][a-z0-9-]*/g;

export function flagsIn(text: string): Set<string> {
  // Drop markdown link targets such as `(contracts.md#cli---json-output)`.
  return new Set(text.replace(/\]\([^)]*\)/g, ']').match(FLAG_RE) ?? []);
}

/** Flags documented for `command`: its table rows, or the whole `### \`orc <command>\`` section. */
export function docFlags(doc: string, command: string): Set<string> | null {
  const heading = new RegExp(`^### \`orc ${command}\`\\s*$`, 'm').exec(doc);
  let text: string;
  if (heading) {
    const rest = doc.slice(heading.index + heading[0].length);
    // Table rows only: bullets below may name flags of other commands.
    text = rest.split(/^#{1,3} /m)[0].split('\n').filter((line) => line.startsWith('|')).join('\n');
  } else {
    const rows = doc.split('\n').filter((line) => {
      if (!line.startsWith('|')) return false;
      const cell = (line.split('|')[1] ?? '').trim().replace(/`/g, '');
      return cell === command || cell.startsWith(`${command} `) || cell.startsWith(`${command}<`);
    });
    if (rows.length === 0) return null;
    text = rows.join('\n');
  }
  const flags = flagsIn(text);
  for (const ignored of NOT_FLAGS[command] ?? []) flags.delete(ignored);
  return flags;
}

describe('docs/cli.md and cli/usage.ts list the same flags', () => {
  for (const [command, usage] of Object.entries(USAGE)) {
    it(`orc ${command}`, () => {
      const documented = docFlags(DOC, command);
      expect(documented, `docs/cli.md has no row or section for \`${command}\``).not.toBeNull();
      const fromUsage = flagsIn(usage);
      expect([...fromUsage].filter((f) => !documented!.has(f)), 'in usage.ts, missing from docs/cli.md').toEqual([]);
      expect([...documented!].filter((f) => !fromUsage.has(f)), 'in docs/cli.md, missing from usage.ts').toEqual([]);
    });
  }

  it('detects a flag removed from one side', () => {
    const doc = '| `start-session` | `[--provider=<p>]` `[--reset]` |';
    expect(docFlags(doc, 'start-session')).toEqual(new Set(['--provider', '--reset']));
    expect(docFlags(doc.replace('`[--reset]`', ''), 'start-session')).toEqual(new Set(['--provider']));
  });
});
