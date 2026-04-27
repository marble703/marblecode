import readline from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { stdin as input, stdout as output } from 'node:process';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { runAgent } from '../agent/index.js';
import { runPlanner } from '../planner/index.js';
import { PolicyEngine } from '../policy/index.js';
import { createProviders } from '../provider/index.js';
import { resolvePlannerSessionDir, isPlannerSessionDir, listRecentSessions, type SessionListItem } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools, createPlannerTools } from '../tools/builtins.js';
import { loadPlannerView, type PlannerEventRecord, type PlannerViewModel } from '../planner/view-model.js';
import { formatPlannerView, renderPlannerEvent } from './planner-view.js';
import { watchPlannerSession } from './planner-live.js';

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
  action?: TuiAction;
}

type TuiAction =
  | ({
      type: 'resume_planner';
      prompt: string;
      executeSubtasks: boolean;
    } & PlannerTarget)
  | ({
      type: 'follow_planner';
      pollMs: number;
    } & PlannerTarget)
  | ({
      type: 'inspect_planner_step';
      stepRef: string;
    } & PlannerTarget)
  | ({
      type: 'open_child_session';
      stepRef: string;
    } & PlannerTarget);

interface PlannerTarget {
  sessionRef?: string;
  useLatestSession?: boolean;
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
            '/add-file path1 path2',
            '/remove-file path1 path2',
            '/clear-files',
            '/paste (enter multiline paste mode, finish with a single . line)',
            '/clear-paste',
            '/verify <command>',
            '/clear-verify',
            '/yes on|off',
            '/sessions',
            '/open <index|session-id-or-path>',
            '/resume [index|session-id-or-path|last]',
            '/replan <extra prompt>   (uses opened or latest planner session)',
            '/follow [index|session-id-or-path|last]',
            '/inspect step <step-id|index>',
            '/open-child <step-id|index>',
            '/show-state',
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
    case 'add-file': {
      const files = args.split(/\s+/).filter(Boolean);
      if (files.length === 0) {
        return { state: { ...state, lastOutput: 'No files provided.' }, quit: false, enterPaste: false };
      }

      const explicitFiles = [...new Set([...state.explicitFiles, ...files])];
      return { state: { ...state, explicitFiles, lastOutput: `Files updated: ${explicitFiles.join(', ')}` }, quit: false, enterPaste: false };
    }
    case 'remove-file': {
      const files = args.split(/\s+/).filter(Boolean);
      if (files.length === 0) {
        return { state: { ...state, lastOutput: 'No files provided.' }, quit: false, enterPaste: false };
      }

      const toRemove = new Set(files);
      const explicitFiles = state.explicitFiles.filter((file) => !toRemove.has(file));
      return { state: { ...state, explicitFiles, lastOutput: explicitFiles.length > 0 ? `Files updated: ${explicitFiles.join(', ')}` : 'Files cleared.' }, quit: false, enterPaste: false };
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
    case 'resume': {
      if (state.mode === 'run') {
        return { state: { ...state, lastOutput: 'Switch to /mode plan or /mode execute before resuming a planner session.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, args);
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Resuming planner session${formatPlannerTargetLabel(target)}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'resume_planner',
          prompt: '',
          executeSubtasks: state.mode === 'execute',
          ...target,
        },
      };
    }
    case 'replan': {
      if (state.mode === 'run') {
        return { state: { ...state, lastOutput: 'Switch to /mode plan or /mode execute before replanning a planner session.' }, quit: false, enterPaste: false };
      }
      if (!args) {
        return { state: { ...state, lastOutput: 'Provide additional planner input after /replan.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Replanning current planner session with: ${args}` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'resume_planner',
          prompt: args,
          executeSubtasks: state.mode === 'execute',
          ...target,
        },
      };
    }
    case 'follow': {
      const target = resolvePlannerTarget(state, args);
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Opening live planner view${formatPlannerTargetLabel(target)}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'follow_planner',
          pollMs: 1000,
          ...target,
        },
      };
    }
    case 'inspect': {
      const [subcommand, ...inspectRest] = args.split(/\s+/).filter(Boolean);
      if (subcommand !== 'step') {
        return { state: { ...state, lastOutput: 'Use /inspect step <step-id|index>.' }, quit: false, enterPaste: false };
      }
      const stepRef = inspectRest.join(' ').trim();
      if (!stepRef) {
        return { state: { ...state, lastOutput: 'Provide a planner step id or index to inspect.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Inspecting planner step ${stepRef}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'inspect_planner_step',
          stepRef,
          ...target,
        },
      };
    }
    case 'open-child': {
      const stepRef = args.trim();
      if (!stepRef) {
        return { state: { ...state, lastOutput: 'Provide a planner step id or index to open its child session.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Opening child session for planner step ${stepRef}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'open_child_session',
          stepRef,
          ...target,
        },
      };
    }
    case 'show-state':
      return {
        state: {
          ...state,
          lastOutput: renderTuiStateSummary(state),
        },
        quit: false,
        enterPaste: false,
      };
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
  let rl = readline.createInterface({ input, output });
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

      if (commandResult.action) {
        try {
          const actionResult = await executeTuiAction(configPath, state, commandResult.action);
          state = await refreshTuiState(configPath, actionResult.state);
          if (actionResult.followSessionDir) {
            rl.close();
            await watchPlannerSession(actionResult.followSessionDir, actionResult.followPollMs ?? 1000);
            rl = readline.createInterface({ input, output });
            state = await refreshTuiState(configPath, {
              ...state,
              lastOutput: `Closed live planner view for ${actionResult.followSessionDir}`,
            });
          }
        } catch (error) {
          state = await refreshTuiState(configPath, {
            ...state,
            lastOutput: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
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

async function executeTuiAction(
  configPath: string | undefined,
  state: TuiState,
  action: TuiAction,
): Promise<{ state: TuiState; followSessionDir?: string; followPollMs?: number }> {
  const config = await loadConfig(configPath, state.workspaceRoot);

  if (action.type === 'follow_planner') {
    const sessionDir = await resolvePlannerSessionDir(config, action.sessionRef, action.useLatestSession);
    return {
      state: {
        ...state,
        lastSessionDir: sessionDir,
      },
      followSessionDir: sessionDir,
      followPollMs: action.pollMs,
    };
  }

  if (action.type === 'inspect_planner_step') {
    const sessionDir = await resolvePlannerSessionDir(config, action.sessionRef, action.useLatestSession);
    const inspection = await inspectPlannerStep(sessionDir, action.stepRef);
    return {
      state: {
        ...state,
        lastSessionDir: sessionDir,
        lastOutput: inspection,
      },
    };
  }

  if (action.type === 'open_child_session') {
    const sessionDir = await resolvePlannerSessionDir(config, action.sessionRef, action.useLatestSession);
    const child = await resolvePlannerChildSession(sessionDir, action.stepRef);
    return {
      state: {
        ...state,
        lastSessionDir: child.sessionDir,
        plannerView: null,
        lastOutput: child.summary,
      },
    };
  }

  const providers = createProviders(config);
  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  for (const tool of createPlannerTools(config, policy)) {
    registry.register(tool);
  }

  const result = await runPlanner(config, providers, registry, {
    prompt: action.prompt,
    explicitFiles: state.explicitFiles,
    pastedSnippets: state.pastedSnippets,
    ...(action.executeSubtasks ? { executeSubtasks: true } : {}),
    ...(action.sessionRef ? { resumeSessionRef: action.sessionRef } : {}),
    ...(action.useLatestSession ? { useLatestSession: true } : {}),
  });

  let plannerSummary = `${result.status}: ${result.message}\nsession: ${result.sessionDir}`;
  try {
    const view = await loadPlannerView(result.sessionDir);
    plannerSummary = formatPlannerView(view);
  } catch {
    plannerSummary = `${plannerSummary}\n(no planner summary available)`;
  }

  return {
    state: {
      ...state,
      lastSessionDir: result.sessionDir,
      plannerView: null,
      lastOutput: plannerSummary,
    },
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
      output.write(`${index + 1}. ${session.id} ${formatSessionBadge(session)}\n`);
      output.write(`   ${session.summary}\n`);
    }
  }

  if (state.plannerView) {
    output.write('\nPlanner Panel\n');
    output.write(`${formatPlannerView(state.plannerView)}\n\n`);
  }

  output.write('Tips: type a prompt to run it, /help for commands.\n');
}

function resolvePlannerTarget(
  state: TuiState,
  rawTarget: string,
): PlannerTarget | { error: string } {
  const target = rawTarget.trim();
  if (!target) {
    if (state.plannerView && state.lastSessionDir) {
      return { sessionRef: state.lastSessionDir };
    }

    const latestPlanner = state.recentSessions.find((session) => session.isPlanner);
    if (latestPlanner) {
      return { sessionRef: latestPlanner.dir };
    }

    return { error: 'No planner session is open. Use /open or /sessions first.' };
  }

  if (target === 'last') {
    return { useLatestSession: true };
  }

  const numericIndex = Number(target);
  if (Number.isInteger(numericIndex) && numericIndex > 0) {
    const session = state.recentSessions[numericIndex - 1];
    if (!session) {
      return { error: `No session found for ${target}` };
    }
    if (!session.isPlanner) {
      return { error: `Session ${target} is not a planner session.` };
    }

    return { sessionRef: session.dir };
  }

  return { sessionRef: target };
}

function formatPlannerTargetLabel(target: PlannerTarget): string {
  if (target.useLatestSession) {
    return ' (latest planner session)';
  }
  if (target.sessionRef) {
    return ` (${target.sessionRef})`;
  }

  return '';
}

function renderTuiStateSummary(state: TuiState): string {
  return [
    `mode: ${state.mode}`,
    `workspace: ${state.workspaceRoot}`,
    `explicit files: ${state.explicitFiles.length > 0 ? state.explicitFiles.join(', ') : '(none)'}`,
    `pasted snippets: ${state.pastedSnippets.length}`,
    `verifier override: ${state.manualVerifierCommands[0] ?? '(none)'}`,
    `auto-approve: ${state.autoApprove}`,
    `last session: ${state.lastSessionDir ?? '(none)'}`,
  ].join('\n');
}

function formatSessionBadge(session: SessionListItem): string {
  if (!session.isPlanner) {
    return '(child)';
  }

  const fragments = [session.outcome ?? 'planner', session.phase ?? 'unknown'];
  if ('currentStepId' in session && session.currentStepId) {
    fragments.push(`step=${session.currentStepId}`);
  }
  return `(planner ${fragments.join(' ')})`;
}

async function inspectPlannerStep(sessionDir: string, stepRef: string): Promise<string> {
  const view = await loadPlannerView(sessionDir);
  const step = resolvePlannerStep(view, stepRef);
  const latestEvent = findLatestStepEvent(view.subtaskEvents, step.id);
  const artifacts = await collectPlannerStepArtifacts(sessionDir, step.id);

  return [
    `Planner session: ${sessionDir}`,
    `Step: ${step.id}`,
    `Title: ${step.title}`,
    `Status: ${step.status}`,
    `Kind: ${step.kind}`,
    step.details ? `Details: ${step.details}` : '',
    step.relatedFiles.length > 0 ? `Files: ${step.relatedFiles.join(', ')}` : 'Files: (none)',
    latestEvent ? `Latest event: ${renderPlannerEvent(latestEvent)}` : 'Latest event: (none)',
    artifacts.length > 0 ? `Artifacts: ${artifacts.join(', ')}` : 'Artifacts: (none)',
    latestEvent?.sessionDir ? `Child session: ${String(latestEvent.sessionDir)}` : '',
  ].filter(Boolean).join('\n');
}

async function resolvePlannerChildSession(sessionDir: string, stepRef: string): Promise<{ sessionDir: string; summary: string }> {
  const view = await loadPlannerView(sessionDir);
  const step = resolvePlannerStep(view, stepRef);
  const latestEvent = findLatestStepEvent(view.subtaskEvents, step.id);
  const childSessionDir = typeof latestEvent?.sessionDir === 'string' ? latestEvent.sessionDir : '';
  if (!childSessionDir) {
    throw new Error(`Planner step ${step.id} does not have a recorded child session.`);
  }

  const request = await readJsonFile<{ prompt?: string }>(path.join(childSessionDir, 'request.json'));
  const verify = await readJsonFile<{ success?: boolean; failures?: unknown[] }>(path.join(childSessionDir, 'verify.json'));
  const changedFiles = Array.isArray(latestEvent?.changedFiles)
    ? latestEvent.changedFiles.filter((file): file is string => typeof file === 'string')
    : [];

  return {
    sessionDir: childSessionDir,
    summary: [
      `Child session: ${childSessionDir}`,
      `Planner step: ${step.id} ${step.title}`,
      request?.prompt ? `Prompt: ${request.prompt}` : '',
      changedFiles.length > 0 ? `Changed files: ${changedFiles.join(', ')}` : 'Changed files: (none)',
      typeof verify?.success === 'boolean' ? `Verify: ${verify.success ? 'passed' : `failed (${verify.failures?.length ?? 0} failures)`}` : 'Verify: unavailable',
    ].filter(Boolean).join('\n'),
  };
}

function resolvePlannerStep(view: PlannerViewModel, stepRef: string): PlannerViewModel['steps'][number] {
  const numericIndex = Number(stepRef);
  if (Number.isInteger(numericIndex) && numericIndex > 0) {
    const step = view.steps[numericIndex - 1];
    if (step) {
      return step;
    }
  }

  const exact = view.steps.find((step) => step.id === stepRef);
  if (exact) {
    return exact;
  }

  throw new Error(`No planner step found for ${stepRef}`);
}

function findLatestStepEvent(events: PlannerEventRecord[], stepId: string): PlannerEventRecord | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (String(event?.stepId ?? '') === stepId) {
      return event;
    }
  }

  return undefined;
}

async function collectPlannerStepArtifacts(sessionDir: string, stepId: string): Promise<string[]> {
  const candidates = [
    `subtask.${stepId}.json`,
    `subtask.${stepId}.verify.json`,
    `subtask.${stepId}.repair.json`,
  ];
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await readJsonFile(path.join(sessionDir, candidate))) {
      found.push(candidate);
    }
  }

  return found;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
