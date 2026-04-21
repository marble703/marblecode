import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { runAgent } from '../agent/index.js';
import { runPlanner } from '../planner/index.js';
import { PolicyEngine } from '../policy/index.js';
import { createProviders } from '../provider/index.js';
import type { ModelProvider } from '../provider/types.js';
import { isPlannerSessionDir, listRecentSessions, type SessionListItem } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools, createPlannerTools } from '../tools/builtins.js';
import { loadPlannerView, formatPlannerView, type PlannerViewModel } from './planner-view.js';

export type TuiMode = 'run' | 'plan' | 'execute';

export interface TuiState {
  mode: TuiMode;
  workspaceRoot: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  manualVerifierCommands: string[];
  autoApprove: boolean;
  lastSessionDir: string | null;
  lastOutput: string;
  recentSessions: SessionListItem[];
  plannerView: PlannerViewModel | null;
}

export interface TuiCommandResult {
  state: TuiState;
  quit: boolean;
  enterPaste: boolean;
}

export function createInitialTuiState(workspaceRoot = process.cwd()): TuiState {
  return {
    mode: 'run',
    workspaceRoot,
    explicitFiles: [],
    pastedSnippets: [],
    manualVerifierCommands: [],
    autoApprove: false,
    lastSessionDir: null,
    lastOutput: 'Type a prompt to start a new task. Use /help for commands.',
    recentSessions: [],
    plannerView: null,
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
            '/workspace <path>',
            '/files path1 path2',
            '/clear-files',
            '/paste (enter multiline paste mode, finish with a single . line)',
            '/clear-paste',
            '/verify <command>',
            '/clear-verify',
            '/yes on|off',
            '/sessions',
            '/open <index|session-id-or-path>',
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
    case 'workspace': {
      const nextWorkspace = args ? path.resolve(args) : state.workspaceRoot;
      return { state: { ...state, workspaceRoot: nextWorkspace, lastSessionDir: null, plannerView: null, lastOutput: `Workspace set to ${nextWorkspace}` }, quit: false, enterPaste: false };
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
    case 'sessions':
      return { state: { ...state, lastOutput: 'Recent sessions refreshed below.' }, quit: false, enterPaste: false };
    case 'open': {
      const target = args.trim();
      if (!target) {
        return { state: { ...state, lastOutput: 'Provide a session index or path to open.' }, quit: false, enterPaste: false };
      }

      const numericIndex = Number(target);
      const selected = Number.isInteger(numericIndex) && numericIndex > 0
        ? state.recentSessions[numericIndex - 1]?.dir ?? null
        : target;
      if (!selected) {
        return { state: { ...state, lastOutput: `No session found for ${target}` }, quit: false, enterPaste: false };
      }
      return { state: { ...state, lastSessionDir: selected, lastOutput: `Opened session ${selected}` }, quit: false, enterPaste: false };
    }
    case 'reset':
      return { state: { ...createInitialTuiState(state.workspaceRoot), lastOutput: 'TUI state reset.' }, quit: false, enterPaste: false };
    case 'quit':
    case 'exit':
      return { state, quit: true, enterPaste: false };
    default:
      return { state: { ...state, lastOutput: `Unknown command: /${command}` }, quit: false, enterPaste: false };
  }
}

export async function runInteractiveTui(
  configPath: string | undefined,
  initialConfig: AppConfig,
): Promise<void> {
  const rl = readline.createInterface({ input, output });
  let state = await refreshTuiState(configPath, createInitialTuiState(initialConfig.workspaceRoot));

  try {
    while (true) {
      renderTuiScreen(state);
      let line: string;
      try {
        line = await rl.question('tui> ');
      } catch (error) {
        if (error instanceof Error && /readline was closed/i.test(error.message)) {
          break;
        }
        throw error;
      }
      const commandResult = applyTuiCommand(state, line);
      state = await refreshTuiState(configPath, commandResult.state);

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
        state = await refreshTuiState(configPath, await executeTuiPrompt(configPath, initialConfig, state, prompt, rl));
      } catch (error) {
        state = await refreshTuiState(configPath, {
          ...state,
          lastOutput: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    rl.close();
  }
}

async function executeTuiPrompt(
  configPath: string | undefined,
  initialConfig: AppConfig,
  state: TuiState,
  prompt: string,
  rl: readline.Interface,
): Promise<TuiState> {
  const config = await loadConfig(configPath, state.workspaceRoot);
  const providers = createProviders(config);
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
    plannerView: null,
    lastOutput: plannerSummary,
  };
}

async function refreshTuiState(configPath: string | undefined, state: TuiState): Promise<TuiState> {
  const config = await loadConfig(configPath, state.workspaceRoot);
  const recentSessions = await listRecentSessions(config, 8);
  let plannerView: PlannerViewModel | null = null;
  if (state.lastSessionDir) {
    const sessionDir = path.isAbsolute(state.lastSessionDir)
      ? state.lastSessionDir
      : path.join(config.workspaceRoot, config.session.dir, state.lastSessionDir);
    if (await isPlannerSessionDir(sessionDir)) {
      try {
        plannerView = await loadPlannerView(sessionDir);
      } catch {
        plannerView = null;
      }
    }
  }

  return {
    ...state,
    recentSessions,
    plannerView,
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
  output.write(`mode=${state.mode} workspace=${state.workspaceRoot} autoApprove=${state.autoApprove} files=${state.explicitFiles.length} pasted=${state.pastedSnippets.length} verify=${state.manualVerifierCommands.length > 0 ? 'on' : 'off'}\n`);
  output.write(`lastSession=${state.lastSessionDir ?? '(none)'}\n\n`);
  output.write(`${state.lastOutput}\n\n`);
  output.write('Recent Sessions\n');
  if (state.recentSessions.length === 0) {
    output.write('- none\n');
  } else {
    for (const [index, session] of state.recentSessions.entries()) {
      output.write(`${index + 1}. ${session.id} ${session.isPlanner ? '(planner)' : '(child)'}\n`);
    }
  }

  if (state.plannerView) {
    output.write('\nPlanner Panel\n');
    output.write(`${formatPlannerView(state.plannerView)}\n\n`);
  }

  output.write('Tips: type a prompt to run it, /help for commands.\n');
}
