import path from 'node:path';
import { readFile } from 'node:fs/promises';

export interface PlannerEventRecord {
  type?: string;
  [key: string]: unknown;
}

export interface PlannerViewModel {
  sessionDir: string;
  outcome: string;
  phase: string;
  currentStepId: string | null;
  activeStepIds: string[];
  readyStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  blockedStepIds: string[];
  executionWaves: Array<{ index: number; stepIds: string[] }>;
  fallbackEdges: Array<{ from: string; to: string }>;
  lockEntries: Array<{ path: string; mode: string; ownerStepId: string }>;
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    status: string;
    kind: string;
    attempts: number;
    details?: string;
    relatedFiles: string[];
    children: string[];
    assignee?: string;
    executionState?: string;
    lastError?: string;
    failureKind?: string;
  }>;
  events: PlannerEventRecord[];
  subtaskEvents: PlannerEventRecord[];
  consistencyErrors: string[];
  terminalSummary: string;
}

export async function loadPlannerView(sessionDir: string): Promise<PlannerViewModel> {
  const [planRaw, stateRaw, eventsRaw, plannerLogRaw, executionGraphRaw, executionLocksRaw] = await Promise.all([
    readTextIfExists(path.join(sessionDir, 'plan.json')),
    readTextIfExists(path.join(sessionDir, 'plan.state.json')),
    readTextIfExists(path.join(sessionDir, 'plan.events.jsonl')),
    readTextIfExists(path.join(sessionDir, 'planner.log.jsonl')),
    readTextIfExists(path.join(sessionDir, 'execution.graph.json')),
    readTextIfExists(path.join(sessionDir, 'execution.locks.json')),
  ]);

  const plan = parseJsonWithFallback(planRaw, {
    summary: 'Planner session has not produced a plan yet.',
    steps: [],
  }) as {
    summary: string;
    steps: Array<{
      id: string;
      title: string;
      status: string;
      kind: string;
      attempts?: number;
      details?: string;
      relatedFiles?: string[];
      children: string[];
      assignee?: string;
      executionState?: string;
      lastError?: string;
      failureKind?: string;
    }>;
  };
  const state = parseJsonWithFallback(stateRaw, {
    phase: 'PENDING',
    outcome: 'RUNNING',
    message: 'Planner session is still initializing.',
    currentStepId: null,
    activeStepIds: [],
    readyStepIds: [],
    completedStepIds: [],
    failedStepIds: [],
    blockedStepIds: [],
    consistencyErrors: [],
  }) as {
    phase: string;
    outcome: string;
    message: string;
    currentStepId: string | null;
    activeStepIds?: string[];
    readyStepIds?: string[];
    completedStepIds?: string[];
    failedStepIds?: string[];
    blockedStepIds?: string[];
    consistencyErrors: string[];
  };
  const events = parseJsonLines(eventsRaw);
  const plannerLog = parseJsonLines(plannerLogRaw);
  const executionGraph = parseJsonWithFallback(executionGraphRaw, { waves: [], edges: [] }) as { waves?: Array<{ index: number; stepIds: string[] }>; edges?: Array<{ from: string; to: string; type: string }> };
  const executionLocks = parseJsonWithFallback(executionLocksRaw, { entries: [] }) as { entries?: Array<{ path: string; mode: string; ownerStepId: string }> };
  const subtaskEvents = events.filter((event) => {
    const type = String(event.type ?? '');
    return type.startsWith('subtask') || type === 'planner_execution_started' || type === 'planner_execution_finished';
  });
  const terminal = findLastMatching(plannerLog, (entry) => entry.type === 'planner_terminal');

  return {
    sessionDir,
    outcome: state.outcome,
    phase: state.phase,
    currentStepId: state.currentStepId,
    activeStepIds: state.activeStepIds ?? [],
    readyStepIds: state.readyStepIds ?? [],
    completedStepIds: state.completedStepIds ?? [],
    failedStepIds: state.failedStepIds ?? [],
    blockedStepIds: state.blockedStepIds ?? [],
    executionWaves: executionGraph.waves ?? [],
    fallbackEdges: (executionGraph.edges ?? [])
      .filter((edge) => edge.type === 'fallback')
      .map((edge) => ({ from: edge.from, to: edge.to })),
    lockEntries: executionLocks.entries ?? [],
    summary: plan.summary || state.message,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      kind: step.kind,
      attempts: step.attempts ?? 0,
      ...(step.details ? { details: step.details } : {}),
      relatedFiles: step.relatedFiles ?? [],
      children: step.children,
      ...(step.assignee ? { assignee: step.assignee } : {}),
      ...(step.executionState ? { executionState: step.executionState } : {}),
      ...(step.lastError ? { lastError: step.lastError } : {}),
      ...(step.failureKind ? { failureKind: step.failureKind } : {}),
    })),
    events,
    subtaskEvents,
    consistencyErrors: state.consistencyErrors,
    terminalSummary: terminal ? `${String(terminal.outcome ?? '')} ${String(terminal.message ?? '')}`.trim() : 'unavailable',
  };
}

export function formatPlannerView(view: PlannerViewModel): string {
  const lines: string[] = [
    `Session: ${view.sessionDir}`,
    `Outcome: ${view.outcome}`,
    `Phase: ${view.phase}`,
    `Current step: ${view.currentStepId ?? '(none)'}`,
    `Active steps: ${view.activeStepIds.join(', ') || '(none)'}`,
    `Ready steps: ${view.readyStepIds.join(', ') || '(none)'}`,
    `Failed steps: ${view.failedStepIds.join(', ') || '(none)'}`,
    `Blocked steps: ${view.blockedStepIds.join(', ') || '(none)'}`,
    `Execution waves: ${view.executionWaves.length > 0 ? view.executionWaves.map((wave) => `${wave.index}:${wave.stepIds.join(',')}`).join(' | ') : '(none)'}`,
    `Fallbacks: ${view.fallbackEdges.length > 0 ? view.fallbackEdges.map((edge) => `${edge.from}->${edge.to}`).join(', ') : '(none)'}`,
    `Locks: ${view.lockEntries.length > 0 ? view.lockEntries.map((entry) => `${entry.path}:${entry.mode}:${entry.ownerStepId}`).join(', ') : '(none)'}`,
    `Summary: ${view.summary}`,
    '',
    'Plan Steps:',
  ];

  for (const [index, step] of view.steps.entries()) {
    lines.push(`${index + 1}. [${step.status}] ${step.title} (${step.kind})`);
    lines.push(`   attempts: ${step.attempts}${step.executionState ? ` state=${step.executionState}` : ''}`);
    if (step.details) {
      lines.push(`   ${step.details}`);
    }
    if (step.relatedFiles.length > 0) {
      lines.push(`   files: ${step.relatedFiles.join(', ')}`);
    }
    if (step.children.length > 0) {
      lines.push(`   subtasks: ${step.children.join(', ')}`);
    }
    if (step.assignee) {
      lines.push(`   assignee: ${step.assignee}`);
    }
    if (step.failureKind || step.lastError) {
      lines.push(`   failure: ${step.failureKind ?? 'unknown'}${step.lastError ? ` ${step.lastError}` : ''}`);
    }
  }

  lines.push('', 'Execution Timeline:');
  for (const event of view.events) {
    lines.push(`- ${renderPlannerEvent(event)}`);
  }

  lines.push('', 'Subtask Results:');
  if (view.subtaskEvents.length === 0) {
    lines.push('- none recorded yet');
  } else {
    for (const event of view.subtaskEvents) {
      lines.push(`- ${renderPlannerEvent(event)}`);
    }
  }

  lines.push('', 'Planner Log Summary:');
  lines.push(`- terminal: ${view.terminalSummary}`);
  if (view.consistencyErrors.length > 0) {
    lines.push(`- consistency errors: ${view.consistencyErrors.join('; ')}`);
  }

  return lines.join('\n');
}

export function parseJsonLines(content: string): PlannerEventRecord[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as PlannerEventRecord];
      } catch {
        return [];
      }
    });
}

export function renderPlannerEvent(event: PlannerEventRecord): string {
  const type = String(event.type ?? 'event');
  if (type === 'plan_set') {
    return `plan set (revision ${String(event.revision ?? '')}, ${String(event.stepCount ?? '')} steps)`;
  }
  if (type === 'plan_step_updated') {
    return `${String(event.stepId ?? '')} -> ${String(event.status ?? '')}${event.message ? ` (${String(event.message)})` : ''}`;
  }
  if (type === 'tool_result') {
    return `tool ${String(event.tool ?? '')}: ${String(event.ok ?? '')}`;
  }
  if (type === 'planner_invalid_output') {
    return `invalid output retry ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')}: ${String(event.error ?? '')}`;
  }
  if (type === 'planner_model_retry') {
    return `model retry ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')} after ${String(event.delayMs ?? '')}ms: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_model_fallback') {
    return `planner model fallback ${String(event.fromModelAlias ?? '')} -> ${String(event.toModelAlias ?? '')}`;
  }
  if (type === 'planner_finished') {
    return `finished ${String(event.outcome ?? '')}: ${String(event.message ?? '')}`;
  }
  if (type === 'planner_execution_started') {
    return 'subtask execution started';
  }
  if (type === 'planner_execution_finished') {
    return `subtask execution finished: ${String(event.outcome ?? '')}`;
  }
  if (type === 'subtask_retry_scheduled') {
    return `${String(event.stepId ?? '')} retry scheduled ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')}: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_retry_started') {
    return `${String(event.stepId ?? '')} retry started (${String(event.modelAlias ?? '')}) attempt=${String(event.attempt ?? '')}`;
  }
  if (type === 'subtask_fallback_started') {
    return `${String(event.stepId ?? '')} fallback ${String(event.fromModelAlias ?? '')} -> ${String(event.toModelAlias ?? '')}`;
  }
  if (type === 'subtask_fallback_activated') {
    return `${String(event.failedStepId ?? '')} activated fallback ${String(event.fallbackStepId ?? '')}: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_failed') {
    return `failed: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_started') {
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    return `${String(event.stepId ?? '')} started (${String(event.executor ?? '')}${alias})`;
  }
  if (type === 'subtask_completed') {
    const files = Array.isArray(event.changedFiles) && event.changedFiles.length > 0 ? ` files=${event.changedFiles.join(',')}` : '';
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    const sessionDir = event.sessionDir ? ` session=${String(event.sessionDir)}` : '';
    return `${String(event.stepId ?? '')} completed (${String(event.executor ?? '')}${alias})${files}${sessionDir}`;
  }
  if (type === 'subtask_failed') {
    const alias = event.modelAlias ? `/${String(event.modelAlias)}` : '';
    return `${String(event.stepId ?? '')} failed (${String(event.executor ?? '')}${alias}): ${String(event.message ?? event.reason ?? '')}`;
  }
  if (type === 'subtask_skipped') {
    return `${String(event.stepId ?? '')} skipped: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_verify_failed') {
    return `${String(event.stepId ?? '')} verify failed`;
  }
  if (type === 'subtask_replanned') {
    return `${String(event.stepId ?? '')} replanned revision ${String(event.revision ?? '')}`;
  }
  if (type === 'subtask_replan_failed') {
    return `${String(event.stepId ?? '')} replan failed: ${String(event.reason ?? '')}`;
  }
  if (type === 'subtask_blocked') {
    return `${String(event.stepId ?? '')} blocked: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_started' || type === 'planner_resumed' || type === 'planner_replanned') {
    return `${type}: ${String(event.prompt ?? '')}`;
  }
  return `${type}: ${JSON.stringify(event)}`;
}

function findLastMatching<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && predicate(item)) {
      return item;
    }
  }

  return undefined;
}

async function readTextIfExists(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

function parseJsonWithFallback<T>(content: string, fallback: T): T {
  if (!content.trim()) {
    return fallback;
  }

  try {
    return JSON.parse(content) as T;
  } catch {
    return fallback;
  }
}
