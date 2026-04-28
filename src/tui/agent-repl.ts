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
import { loadPlannerEvents, loadPlannerView, type PlannerEventRecord, type PlannerViewModel } from '../planner/view-model.js';
import { formatPlannerView, renderPlannerEvent } from './planner-view.js';
import { watchPlannerSession } from './planner-live.js';
import { applyTuiCommand } from './commands.js';
import { collectPastedSnippet, confirmPatchInTui } from './paste.js';
import type { TuiAction, TuiState } from './types.js';

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
  const plannerEvents = await loadPlannerEvents(sessionDir);
  const latestEvent = findLatestStepEvent(plannerEvents.subtaskEvents, step.id);
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
