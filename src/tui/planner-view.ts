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
  summary: string;
  steps: Array<{
    id: string;
    title: string;
    status: string;
    kind: string;
    details?: string;
    relatedFiles: string[];
    children: string[];
    assignee?: string;
  }>;
  events: PlannerEventRecord[];
  subtaskEvents: PlannerEventRecord[];
  consistencyErrors: string[];
  terminalSummary: string;
}

export async function loadPlannerView(sessionDir: string): Promise<PlannerViewModel> {
  const [planRaw, stateRaw, eventsRaw, plannerLogRaw] = await Promise.all([
    readFile(path.join(sessionDir, 'plan.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.state.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.events.jsonl'), 'utf8'),
    readFile(path.join(sessionDir, 'planner.log.jsonl'), 'utf8'),
  ]);

  const plan = JSON.parse(planRaw) as {
    summary: string;
    steps: Array<{
      id: string;
      title: string;
      status: string;
      kind: string;
      details?: string;
      relatedFiles?: string[];
      children: string[];
      assignee?: string;
    }>;
  };
  const state = JSON.parse(stateRaw) as {
    phase: string;
    outcome: string;
    message: string;
    currentStepId: string | null;
    consistencyErrors: string[];
  };
  const events = parseJsonLines(eventsRaw);
  const plannerLog = parseJsonLines(plannerLogRaw);
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
    summary: plan.summary || state.message,
    steps: plan.steps.map((step) => ({
      id: step.id,
      title: step.title,
      status: step.status,
      kind: step.kind,
      ...(step.details ? { details: step.details } : {}),
      relatedFiles: step.relatedFiles ?? [],
      children: step.children,
      ...(step.assignee ? { assignee: step.assignee } : {}),
    })),
    events,
    subtaskEvents,
    consistencyErrors: state.consistencyErrors,
    terminalSummary: terminal ? `${String(terminal.outcome ?? '')} ${String(terminal.message ?? '')}`.trim() : 'unavailable',
  };
}

export function parseJsonLines(content: string): PlannerEventRecord[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PlannerEventRecord);
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
