import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { runPlanner } from '../planner/index.js';
import { PolicyEngine } from '../policy/index.js';
import { createProviders } from '../provider/index.js';
import { loadPlannerEvents, loadPlannerView, type PlannerEventRecord, type PlannerViewModel } from '../planner/view-model.js';
import { resolvePlannerSessionDir } from '../session/index.js';
import { createPlannerToolProvider } from '../tools/builtins.js';
import { ToolRegistry } from '../tools/registry.js';
import { formatPlannerView, renderPlannerEvent } from './planner-view.js';
import type { TuiAction, TuiState } from './types.js';

export async function executeTuiAction(
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
  registry.registerProvider(createPlannerToolProvider(config, policy));

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

export async function inspectPlannerStep(sessionDir: string, stepRef: string): Promise<string> {
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

export async function resolvePlannerChildSession(sessionDir: string, stepRef: string): Promise<{ sessionDir: string; summary: string }> {
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
