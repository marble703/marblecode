import type { Interface } from 'node:readline/promises';
import { stdout as output } from 'node:process';
import type { TuiState } from './types.js';

export async function confirmPatchInTui(rl: Interface, message: string): Promise<boolean> {
  output.write(`\nPatch Preview\n${message}\n`);
  const answer = await rl.question('Apply patch? [y/N] ');
  return answer.trim().toLowerCase() === 'y';
}

export async function collectPastedSnippet(rl: Interface, state: TuiState): Promise<TuiState> {
  const lines: string[] = [];
  while (true) {
    const line = await rl.question('paste> ');
    if (line === '.') {
      break;
    }
    lines.push(line);
  }

  const snippet = lines.join('\n').trim();
  if (!snippet) {
    return { ...state, lastOutput: 'Paste cancelled.' };
  }

  return {
    ...state,
    pastedSnippets: [...state.pastedSnippets, snippet],
    lastOutput: `Added pasted snippet #${state.pastedSnippets.length + 1}`,
  };
}
