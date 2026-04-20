import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { runAgent } from '../agent/index.js';
import { runPlanner } from '../planner/index.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools, createPlannerTools } from '../tools/builtins.js';
import { loadPlannerView, formatPlannerView } from './planner-view.js';

export type TuiMode = 'run' | 'plan' | 'execute';

export interface TuiState {
  mode: TuiMode;
  explicitFiles: string[];
  pastedSnippets: string[];
  manualVerifierCommands: string[];
  autoApprove: boolean;
  lastSessionDir: string | null;
  lastOutput: string;
}

export interface TuiCommandResult {
  state: TuiState;
  quit: boolean;
  enterPaste: boolean;
}

export function createInitialTuiState(): TuiState {
  return {
    mode: 'run',
    explicitFiles: [],
    pastedSnippets: [],
    manualVerifierCommands: [],
    autoApprove: false,
    lastSessionDir: null,
    lastOutput: 'Type a prompt to start a new task. Use /help for commands.',
  };
}

export function applyTuiCommand(state: TuiState, line: string): TuiCommandResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) {
    return { state, quit: false, enterPaste: false };
  }

  const [command, ...rest] = trimmed.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();
  switch (command) {
    case 'help':
      return {
        state: {
          ...state,
          lastOutput: [
            'Commands:',
            '/mode run|plan|execute',
            '/files path1 path2',
            '/clear-files',
            '/paste (enter multiline paste mode, finish with a single . line)',
            '/clear-paste',
            '/verify <command>',
            '/clear-verify',
            '/yes on|off',
            '/reset',
            '/quit',
          ].join('\n'),
        },
        quit: false,
        enterPaste: false,
      };
    case 'mode': {
      const mode = args as TuiMode;
      if (mode !== 'run' && mode !== 'plan' && mode !== 'execute') {
        return { state: { ...state, lastOutput: `Unknown mode: ${args}` }, quit: false, enterPaste: false };
      }
      return { state: { ...state, mode, lastOutput: `Mode set to ${mode}` }, quit: false, enterPaste: false };
    }
    case 'files': {
      const files = args.split(/\s+/).filter(Boolean);
      return { state: { ...state, explicitFiles: files, lastOutput: files.length > 0 ? `Files set: ${files.join(', ')}` : 'No files provided.' }, quit: false, enterPaste: false };
    }
    case 'clear-files':
      return { state: { ...state, explicitFiles: [], lastOutput: 'Files cleared.' }, quit: false, enterPaste: false };
    case 'paste':
      return { state, quit: false, enterPaste: true };
    case 'clear-paste':
      return { state: { ...state, pastedSnippets: [], lastOutput: 'Pasted snippets cleared.' }, quit: false, enterPaste: false };
    case 'verify':
      return { state: { ...state, manualVerifierCommands: args ? [args] : [], lastOutput: args ? `Verifier override set: ${args}` : 'Verifier override cleared.' }, quit: false, enterPaste: false };
    case 'clear-verify':
      return { state: { ...state, manualVerifierCommands: [], lastOutput: 'Verifier override cleared.' }, quit: false, enterPaste: false };
    case 'yes': {
      const normalized = args.toLowerCase();
      const autoApprove = normalized === 'on' || normalized === 'true' || normalized === 'yes';
      return { state: { ...state, autoApprove, lastOutput: `Auto-approve set to ${autoApprove}` }, quit: false, enterPaste: false };
    }
    case 'reset':
      return { state: { ...createInitialTuiState(), lastOutput: 'TUI state reset.' }, quit: false, enterPaste: false };
    case 'quit':
    case 'exit':
      return { state, quit: true, enterPaste: false };
    default:
      return { state: { ...state, lastOutput: `Unknown command: /${command}` }, quit: false, enterPaste: false };
  }
}

export async function runInteractiveTui(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
): Promise<void> {
  const rl = readline.createInterface({ input, output });
  let state = createInitialTuiState();

  try {
    while (true) {
      renderTuiScreen(state);
      const line = await rl.question('tui> ');
      const commandResult = applyTuiCommand(state, line);
      state = commandResult.state;

      if (commandResult.quit) {
        break;
      }

      if (commandResult.enterPaste) {
        state = await collectPastedSnippet(rl, state);
        continue;
      }

      if (line.trim().startsWith('/')) {
        continue;
      }

      const prompt = line.trim();
      if (!prompt) {
        state = { ...state, lastOutput: 'Prompt cannot be empty.' };
        continue;
      }

      state = { ...state, lastOutput: `Running ${state.mode} task...` };
      renderTuiScreen(state);

      try {
        state = await executeTuiPrompt(config, providers, state, prompt, rl);
      } catch (error) {
        state = {
          ...state,
          lastOutput: error instanceof Error ? error.message : String(error),
        };
      }
    }
  } finally {
    rl.close();
  }
}

async function executeTuiPrompt(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  state: TuiState,
  prompt: string,
  rl: readline.Interface,
): Promise<TuiState> {
  if (state.mode === 'run') {
    const policy = new PolicyEngine(config);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools(config, policy)) {
      registry.register(tool);
    }
    const result = await runAgent(config, providers, registry, {
      prompt,
      explicitFiles: state.explicitFiles,
      pastedSnippets: state.pastedSnippets,
      manualVerifierCommands: state.manualVerifierCommands,
      autoApprove: state.autoApprove,
      confirm: async (message) => confirmPatchInTui(rl, message),
    });
    return {
      ...state,
      lastSessionDir: result.sessionDir,
      lastOutput: [
        `${result.status}: ${result.message}`,
        `model: ${result.modelAlias}`,
        `session: ${result.sessionDir}`,
        result.changedFiles.length > 0 ? `changed: ${result.changedFiles.join(', ')}` : 'changed: (none)',
      ].join('\n'),
    };
  }

  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  for (const tool of createPlannerTools(config, policy)) {
    registry.register(tool);
  }
  const result = await runPlanner(config, providers, registry, {
    prompt,
    explicitFiles: state.explicitFiles,
    pastedSnippets: state.pastedSnippets,
    ...(state.mode === 'execute' ? { executeSubtasks: true } : {}),
  });

  let plannerSummary = `${result.status}: ${result.message}\nsession: ${result.sessionDir}`;
  try {
    const view = await loadPlannerView(result.sessionDir);
    plannerSummary = formatPlannerView(view);
  } catch {
    plannerSummary = `${plannerSummary}\n(no planner summary available)`;
  }

  return {
    ...state,
    lastSessionDir: result.sessionDir,
    lastOutput: plannerSummary,
  };
}

async function confirmPatchInTui(rl: readline.Interface, message: string): Promise<boolean> {
  output.write(`\nPatch Preview\n${message}\n`);
  const answer = await rl.question('Apply patch? [y/N] ');
  return answer.trim().toLowerCase() === 'y';
}

async function collectPastedSnippet(rl: readline.Interface, state: TuiState): Promise<TuiState> {
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

function renderTuiScreen(state: TuiState): void {
  output.write('\u001bc');
  output.write('Coding Agent TUI\n');
  output.write(`mode=${state.mode} autoApprove=${state.autoApprove} files=${state.explicitFiles.length} pasted=${state.pastedSnippets.length} verify=${state.manualVerifierCommands.length > 0 ? 'on' : 'off'}\n`);
  output.write(`lastSession=${state.lastSessionDir ?? '(none)'}\n\n`);
  output.write(`${state.lastOutput}\n\n`);
  output.write('Tips: type a prompt to run it, /help for commands.\n');
}
