import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';

export interface PlannerEventRecord {
  type?: string;
  [key: string]: unknown;
}

export interface PlannerPlanDeltaSummary {
  baseRevision: number;
  nextRevision: number;
  reason: string;
  planningWindowWaves: number;
  addedStepIds: string[];
  combinedIsPartial: boolean;
}

export interface PlannerFeedbackSummary {
  planRevision: number;
  executionEpoch: number;
  changedFiles: string[];
  undeclaredChangedFiles: string[];
  verifyFailures: Array<{
    stepId: string;
    command: string;
    stderr: string;
  }>;
  triggerReplan: boolean;
  replanReason: string;
}

export interface PlannerReplanProposalSummary {
  stepId: string;
  proposalArtifact: string;
  revision: number | null;
}

export interface PlannerReplanRejectionSummary {
  stepId: string;
  rejectionArtifact: string;
  errors: string[];
}

export interface PlannerTimelineEvent {
  type: string;
  label: string;
  stepId?: string;
  revision?: number;
  epoch?: number;
}

export interface PlannerViewModel {
  sessionDir: string;
  outcome: string;
  phase: string;
  executionPhase: string;
  strategy: string;
  epoch: number;
  planRevision: number;
  planIsPartial: boolean;
  planningHorizonWaveCount: number | null;
  currentStepId: string | null;
  activeStepIds: string[];
  readyStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  blockedStepIds: string[];
  degradedStepIds: string[];
  executionWaves: Array<{ index: number; stepIds: string[] }>;
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  fallbackEdges: Array<{ from: string; to: string }>;
  conflictEdges: Array<{ from: string; to: string; reason: string; domain?: string }>;
  lockEntries: Array<{ path: string; mode: string; ownerStepId: string }>;
  planDeltas: PlannerPlanDeltaSummary[];
  latestFeedback: PlannerFeedbackSummary | null;
  feedbackHistory: PlannerFeedbackSummary[];
  deltaHistory: PlannerPlanDeltaSummary[];
  replanProposals: PlannerReplanProposalSummary[];
  replanRejections: PlannerReplanRejectionSummary[];
  replanHistory: Array<PlannerReplanProposalSummary | PlannerReplanRejectionSummary>;
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
  timeline: PlannerTimelineEvent[];
  subtaskTimeline: PlannerTimelineEvent[];
  consistencyErrors: string[];
  terminalSummary: string;
  recoveryStepId: string | null;
  recoveryReason: string;
}

export async function loadPlannerView(sessionDir: string): Promise<PlannerViewModel> {
  const [
    planRaw,
    stateRaw,
    eventsRaw,
    plannerLogRaw,
    executionGraphRaw,
    executionLocksRaw,
    executionStateRaw,
    latestFeedback,
    planDeltas,
    replanProposals,
    replanRejections,
  ] = await Promise.all([
    readTextIfExists(path.join(sessionDir, 'plan.json')),
    readTextIfExists(path.join(sessionDir, 'plan.state.json')),
    readTextIfExists(path.join(sessionDir, 'plan.events.jsonl')),
    readTextIfExists(path.join(sessionDir, 'planner.log.jsonl')),
    readTextIfExists(path.join(sessionDir, 'execution.graph.json')),
    readTextIfExists(path.join(sessionDir, 'execution.locks.json')),
    readTextIfExists(path.join(sessionDir, 'execution.state.json')),
    loadExecutionFeedback(sessionDir),
    loadPlanDeltaSummaries(sessionDir),
    loadReplanProposalSummaries(sessionDir),
    loadReplanRejectionSummaries(sessionDir),
  ]);

  const plan = parseJsonWithFallback(planRaw, {
    revision: 0,
    summary: 'Planner session has not produced a plan yet.',
    steps: [],
  }) as {
    revision?: number;
    summary: string;
    isPartial?: boolean;
    planningHorizon?: { waveCount?: number };
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
    degradedStepIds?: string[];
    consistencyErrors: string[];
  };
  const events = parseJsonLines(eventsRaw);
  const plannerLog = parseJsonLines(plannerLogRaw);
  const executionGraph = parseJsonWithFallback(executionGraphRaw, { waves: [], edges: [] }) as { waves?: Array<{ index: number; stepIds: string[] }>; edges?: Array<{ from: string; to: string; type: string; reason?: string; domain?: string }> };
  const executionLocks = parseJsonWithFallback(executionLocksRaw, { entries: [] }) as { entries?: Array<{ path: string; mode: string; ownerStepId: string }> };
  const executionState = parseJsonWithFallback(executionStateRaw, {
    executionPhase: 'idle',
    strategy: 'serial',
    epoch: 0,
    currentWaveStepIds: [],
    lastCompletedWaveStepIds: [],
    recoveryStepId: null,
    recoveryReason: '',
  }) as {
    executionPhase?: string;
    strategy?: string;
    epoch?: number;
    currentWaveStepIds?: string[];
    lastCompletedWaveStepIds?: string[];
    recoveryStepId?: string | null;
    recoveryReason?: string;
  };
  const subtaskEvents = events.filter((event) => {
    const type = String(event.type ?? '');
    return type.startsWith('subtask') || type === 'planner_execution_started' || type === 'planner_execution_finished';
  });
  const timeline = normalizePlannerEvents(events);
  const subtaskTimeline = normalizePlannerEvents(subtaskEvents);
  const terminal = findLastMatching(plannerLog, (entry) => entry.type === 'planner_terminal');

  return {
    sessionDir,
    outcome: state.outcome,
    phase: state.phase,
    executionPhase: executionState.executionPhase ?? 'idle',
    strategy: executionState.strategy ?? 'serial',
    epoch: executionState.epoch ?? 0,
    planRevision: typeof plan.revision === 'number' ? plan.revision : 0,
    planIsPartial: plan.isPartial === true,
    planningHorizonWaveCount: typeof plan.planningHorizon?.waveCount === 'number' ? plan.planningHorizon.waveCount : null,
    currentStepId: state.currentStepId,
    activeStepIds: state.activeStepIds ?? [],
    readyStepIds: state.readyStepIds ?? [],
    completedStepIds: state.completedStepIds ?? [],
    failedStepIds: state.failedStepIds ?? [],
    blockedStepIds: state.blockedStepIds ?? [],
    degradedStepIds: state.degradedStepIds ?? [],
    executionWaves: executionGraph.waves ?? [],
    currentWaveStepIds: executionState.currentWaveStepIds ?? [],
    lastCompletedWaveStepIds: executionState.lastCompletedWaveStepIds ?? [],
    fallbackEdges: (executionGraph.edges ?? []).filter((edge) => edge.type === 'fallback').map((edge) => ({ from: edge.from, to: edge.to })),
    conflictEdges: (executionGraph.edges ?? []).filter((edge) => edge.type === 'conflict').map((edge) => ({ from: edge.from, to: edge.to, reason: edge.reason ?? 'unknown', ...(edge.domain ? { domain: edge.domain } : {}) })),
    lockEntries: executionLocks.entries ?? [],
    planDeltas,
    latestFeedback,
    feedbackHistory: latestFeedback ? [latestFeedback] : [],
    deltaHistory: planDeltas,
    replanProposals,
    replanRejections,
    replanHistory: [...replanProposals, ...replanRejections],
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
    timeline,
    subtaskTimeline,
    consistencyErrors: state.consistencyErrors,
    terminalSummary: terminal ? `${String(terminal.outcome ?? '')} ${String(terminal.message ?? '')}`.trim() : 'unavailable',
    recoveryStepId: executionState.recoveryStepId ?? null,
    recoveryReason: executionState.recoveryReason ?? '',
  };
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

export function normalizePlannerEvents(events: PlannerEventRecord[]): PlannerTimelineEvent[] {
  return events.map(normalizePlannerEvent);
}

export function normalizePlannerEvent(event: PlannerEventRecord): PlannerTimelineEvent {
  const type = String(event.type ?? 'event');
  if (type === 'plan_appended') {
    return {
      type,
      label: `plan appended (revision ${String(event.revision ?? '')}, ${String(event.stepCount ?? '')} steps)`,
      ...(typeof event.revision === 'number' ? { revision: event.revision } : {}),
    };
  }
  if (type === 'planner_partial_execution_completed') {
    return {
      type,
      label: `partial execution window completed (revision ${String(event.revision ?? '')})`,
      ...(typeof event.revision === 'number' ? { revision: event.revision } : {}),
    };
  }
  if (type === 'planner_execution_window_completed') {
    return {
      type,
      label: `execution window completed (${String(event.executedWaveCount ?? '')} wave)`,
      ...(typeof event.revision === 'number' ? { revision: event.revision } : {}),
    };
  }
  if (type === 'execution_feedback_undeclared_files') {
    return {
      type,
      label: `execution feedback undeclared files: ${Array.isArray(event.undeclaredFiles) ? event.undeclaredFiles.join(', ') : ''}`,
      ...(typeof event.epoch === 'number' ? { epoch: event.epoch } : {}),
    };
  }
  if (type === 'execution_feedback_verify_failed') {
    return {
      type,
      label: `execution feedback verify failed: ${String(event.stepId ?? '')}`,
      ...(typeof event.epoch === 'number' ? { epoch: event.epoch } : {}),
      ...(typeof event.stepId === 'string' ? { stepId: event.stepId } : {}),
    };
  }
  if (type === 'execution_feedback_replan_scope') {
    return {
      type,
      label: `execution feedback replan scope: ${Array.isArray(event.affectedStepIds) ? event.affectedStepIds.join(', ') : ''}`,
      ...(typeof event.stepId === 'string' ? { stepId: event.stepId } : {}),
    };
  }
  return {
    type,
    label: `${type}: ${JSON.stringify(event)}`,
    ...(typeof event.stepId === 'string' ? { stepId: event.stepId } : {}),
    ...(typeof event.revision === 'number' ? { revision: event.revision } : {}),
    ...(typeof event.epoch === 'number' ? { epoch: event.epoch } : {}),
  };
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

async function loadPlanDeltaSummaries(sessionDir: string): Promise<PlannerPlanDeltaSummary[]> {
  const entries = await readDirIfExists(sessionDir);
  const files = entries.filter((entry) => /^plan\.delta\.\d+\.json$/.test(entry)).sort((left, right) => extractTrailingNumber(left) - extractTrailingNumber(right));
  const deltas: PlannerPlanDeltaSummary[] = [];
  for (const file of files) {
    const raw = await readTextIfExists(path.join(sessionDir, file));
    const parsed = parseJsonWithFallback(raw, null as PlannerPlanDeltaSummary | null);
    if (parsed) {
      deltas.push(parsed);
    }
  }
  return deltas;
}

async function loadExecutionFeedback(sessionDir: string): Promise<PlannerFeedbackSummary | null> {
  const raw = await readTextIfExists(path.join(sessionDir, 'execution.feedback.json'));
  return parseJsonWithFallback(raw, null as PlannerFeedbackSummary | null);
}

async function loadReplanProposalSummaries(sessionDir: string): Promise<PlannerReplanProposalSummary[]> {
  const entries = await readDirIfExists(sessionDir);
  const files = entries.filter((entry) => /^replan\.proposal\..+\.json$/.test(entry)).sort();
  const proposals: PlannerReplanProposalSummary[] = [];
  for (const file of files) {
    const raw = await readTextIfExists(path.join(sessionDir, file));
    const parsed = parseJsonWithFallback(raw, { failedStepId: '', proposedRevision: null as number | null });
    proposals.push({
      stepId: String(parsed.failedStepId ?? ''),
      proposalArtifact: file,
      revision: typeof parsed.proposedRevision === 'number' ? parsed.proposedRevision : null,
    });
  }
  return proposals;
}

async function loadReplanRejectionSummaries(sessionDir: string): Promise<PlannerReplanRejectionSummary[]> {
  const entries = await readDirIfExists(sessionDir);
  const files = entries.filter((entry) => /^replan\.rejected\..+\.json$/.test(entry)).sort();
  const rejections: PlannerReplanRejectionSummary[] = [];
  for (const file of files) {
    const raw = await readTextIfExists(path.join(sessionDir, file));
    const parsed = parseJsonWithFallback(raw, { failedStepId: '', errors: [] as string[] });
    rejections.push({
      stepId: String(parsed.failedStepId ?? ''),
      rejectionArtifact: file,
      errors: Array.isArray(parsed.errors) ? parsed.errors.filter((item): item is string => typeof item === 'string') : [],
    });
  }
  return rejections;
}

async function readDirIfExists(dirPath: string): Promise<string[]> {
  try {
    return await readdir(dirPath);
  } catch {
    return [];
  }
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

function extractTrailingNumber(value: string): number {
  const match = value.match(/(\d+)/g);
  if (!match || match.length === 0) {
    return 0;
  }
  return Number(match.at(-1) ?? '0');
}
