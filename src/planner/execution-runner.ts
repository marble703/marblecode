import { selectRunnableRuntimeBatchFromCandidates } from './execution-scheduler.js';
import { createPlannerRuntimeState } from './execution-runtime-state.js';
import type { PlannerBlockedReason } from './graph.js';
import type { PlannerRuntimeLock } from './execution-runtime-types.js';
import type { PlannerExecutionStrategyMode } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerExecutionFeedbackArtifact, PlannerPlan, PlannerState, PlannerStep, PlannerStepExecutionFeedback, PlannerStepStatus } from './types.js';

export interface PlannerExecutionSelection {
  pendingSteps: PlannerStep[];
  readySteps: PlannerStep[];
  batch: PlannerStep[];
  source: 'ready_queue' | 'legacy_wave' | 'runtime_blocked';
}

export type PlannerExecutionTurnDecision =
  | { kind: 'complete' }
  | { kind: 'blocked_no_ready'; pendingSteps: PlannerStep[]; readySteps: PlannerStep[] }
  | { kind: 'blocked_runtime_locks'; pendingSteps: PlannerStep[]; readySteps: PlannerStep[] }
  | { kind: 'execute_batch'; pendingSteps: PlannerStep[]; readySteps: PlannerStep[]; batch: PlannerStep[]; source: PlannerExecutionSelection['source'] };

export type PlannerReadyQueueSelection =
  | { kind: 'selected'; batch: PlannerStep[] }
  | { kind: 'defer_legacy_fallback' }
  | { kind: 'blocked_by_runtime_locks' };

export interface PlannerBlockedOutcome {
  step: PlannerStep;
  stepUpdates: Partial<PlannerStep>;
  statePatch: Partial<PlannerState>;
  event: {
    reason: string;
    blockedByStepIds: string[];
    blockedReasons?: PlannerBlockedReason[];
  };
  dispatch: {
    recoveryStepId: string;
    recoveryReason: string;
    lastEventReason: string;
    blockedReasons?: PlannerBlockedReason[];
  };
}

export interface PlannerCompletionOutcome {
  statePatch: Partial<PlannerState>;
  finishEvent: {
    outcome: PlannerState['outcome'];
    degradedCompletion?: true;
    degradedStepIds?: string[];
  };
}

export interface PlannerWindowCompletionOutcome {
  statePatch: Partial<PlannerState>;
  windowEvent: {
    revision: number;
    executedWaveCount: number;
    planningWindowWaves: number;
  };
}

export interface PlannerSkipOutcome {
  stepUpdates: Array<{
    stepId: string;
    updates: Partial<PlannerStep>;
  }>;
  events: Array<{
    stepId: string;
    kind: PlannerStep['kind'];
    reason: string;
  }>;
}

export interface PlannerVerifyFeedbackOutcome {
  feedback: PlannerExecutionFeedbackArtifact;
  verifyFailedEvent?: {
    stepId: string;
    epoch: number;
  };
}

export interface PlannerWaveFeedbackOutcome {
  feedback: PlannerExecutionFeedbackArtifact;
  replanEvent?: {
    epoch: number;
    undeclaredFiles: string[];
    triggerReplan: true;
  };
}

export function selectPlannerExecutionBatch(input: {
  plan: PlannerPlan;
  lockTable: ExecutionLockTable;
  strategyMode: PlannerExecutionStrategyMode;
  maxConcurrentSubtasks: number;
  classifyPlannerStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
  getReadySteps: (plan: PlannerPlan) => PlannerStep[];
  selectLegacyWave: (readySteps: PlannerStep[]) => PlannerStep[];
}): PlannerExecutionSelection {
  const pendingSteps = input.plan.steps.filter((step) => step.status !== 'DONE' && step.status !== 'FAILED');
  const readySteps = input.getReadySteps(input.plan);
  const readyQueueSelection = selectPlannerReadyQueueBatch({
    plan: input.plan,
    readySteps,
    lockTable: input.lockTable,
    strategyMode: input.strategyMode,
    maxConcurrentSubtasks: input.maxConcurrentSubtasks,
    classifyPlannerStep: input.classifyPlannerStep,
  });
  if (readyQueueSelection.kind === 'selected') {
    return {
      pendingSteps,
      readySteps,
      batch: readyQueueSelection.batch,
      source: 'ready_queue',
    };
  }

  if (readyQueueSelection.kind === 'blocked_by_runtime_locks') {
    return {
      pendingSteps,
      readySteps,
      batch: [],
      source: 'runtime_blocked',
    };
  }

  return {
    pendingSteps,
    readySteps,
    batch: input.selectLegacyWave(readySteps),
    source: 'legacy_wave',
  };
}

export function decidePlannerExecutionTurn(input: {
  plan: PlannerPlan;
  lockTable: ExecutionLockTable;
  strategyMode: PlannerExecutionStrategyMode;
  maxConcurrentSubtasks: number;
  classifyPlannerStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
  getReadySteps: (plan: PlannerPlan) => PlannerStep[];
  selectLegacyWave: (readySteps: PlannerStep[]) => PlannerStep[];
}): PlannerExecutionTurnDecision {
  const selection = selectPlannerExecutionBatch(input);
  if (selection.pendingSteps.length === 0) {
    return { kind: 'complete' };
  }
  if (selection.readySteps.length === 0) {
    return {
      kind: 'blocked_no_ready',
      pendingSteps: selection.pendingSteps,
      readySteps: selection.readySteps,
    };
  }
  if (selection.source === 'runtime_blocked') {
    return {
      kind: 'blocked_runtime_locks',
      pendingSteps: selection.pendingSteps,
      readySteps: selection.readySteps,
    };
  }
  return {
    kind: 'execute_batch',
    pendingSteps: selection.pendingSteps,
    readySteps: selection.readySteps,
    batch: selection.batch,
    source: selection.source,
  };
}

export function createDependencyBlockedOutcome(input: {
  step: PlannerStep;
  blockedReasons: PlannerBlockedReason[];
}): PlannerBlockedOutcome {
  const blockedSummary = input.blockedReasons.length > 0
    ? input.blockedReasons.map((reason) => reason.kind === 'conflict'
      ? `${reason.kind}:${reason.blockedByStepId}${reason.conflictDomain ? `(${reason.conflictDomain})` : ''}`
      : `${reason.kind}:${reason.blockedByStepId}`).join(', ')
    : input.step.dependencies.join(', ');
  const reason = input.blockedReasons[0]?.message ?? `Planner execution blocked by unmet prerequisites for ${input.step.id}.`;
  return {
    step: input.step,
    stepUpdates: {
      status: 'FAILED',
      executionState: 'failed',
      failureKind: 'dependency',
      lastError: `Blocked by unmet prerequisites: ${blockedSummary}`,
      details: `Blocked by unmet prerequisites: ${blockedSummary}`,
    },
    statePatch: {
      phase: 'BLOCKED',
      outcome: 'FAILED',
      currentStepId: input.step.id,
      message: reason,
    },
    event: {
      reason,
      blockedByStepIds: input.blockedReasons.map((blockedReason) => blockedReason.blockedByStepId),
      ...(input.blockedReasons.length > 0 ? { blockedReasons: input.blockedReasons } : {}),
    },
    dispatch: {
      recoveryStepId: input.step.id,
      recoveryReason: reason,
      lastEventReason: reason,
      ...(input.blockedReasons.length > 0 ? { blockedReasons: input.blockedReasons } : {}),
    },
  };
}

export function createRuntimeLockBlockedOutcome(input: {
  step: PlannerStep;
  activeLockOwners: string[];
}): PlannerBlockedOutcome {
  const reason = input.activeLockOwners.length > 0
    ? `Planner execution cannot continue because ready steps are blocked by active runtime locks held by: ${input.activeLockOwners.join(', ')}.`
    : 'Planner execution cannot continue because ready steps are blocked by active runtime locks.';
  return {
    step: input.step,
    stepUpdates: {
      status: 'FAILED',
      executionState: 'failed',
      failureKind: 'dependency',
      lastError: reason,
      details: reason,
    },
    statePatch: {
      phase: 'BLOCKED',
      outcome: 'FAILED',
      currentStepId: input.step.id,
      message: reason,
    },
    event: {
      reason,
      blockedByStepIds: input.activeLockOwners,
    },
    dispatch: {
      recoveryStepId: input.step.id,
      recoveryReason: reason,
      lastEventReason: reason,
    },
  };
}

export function createPlanningWindowCompletionOutcome(input: {
  plan: PlannerPlan;
  executedWaveCount: number;
  planningWindowWaves: number;
  consistencyErrors: string[];
}): PlannerWindowCompletionOutcome {
  return {
    statePatch: {
      phase: 'PENDING',
      outcome: 'DONE',
      currentStepId: null,
      message: `Executed ${input.executedWaveCount} planning wave${input.executedWaveCount === 1 ? '' : 's'} from partial plan revision ${input.plan.revision}.`,
      consistencyErrors: input.consistencyErrors,
    },
    windowEvent: {
      revision: input.plan.revision,
      executedWaveCount: input.executedWaveCount,
      planningWindowWaves: input.planningWindowWaves,
    },
  };
}

export function createExecutionCompletionOutcome(input: {
  degradedStepIds: string[];
  consistencyErrors: string[];
}): PlannerCompletionOutcome {
  const degradedCompletion = input.degradedStepIds.length > 0;
  return {
    statePatch: {
      phase: 'PENDING',
      outcome: 'DONE',
      currentStepId: null,
      message: degradedCompletion
        ? `Planner executed core subtasks and verifier passed with degraded steps: ${input.degradedStepIds.join(', ')}.`
        : 'Planner executed all subtasks and verifier passed.',
      consistencyErrors: input.consistencyErrors,
      ...(degradedCompletion ? { degradedCompletion: true } : {}),
    },
    finishEvent: {
      outcome: 'DONE',
      ...(degradedCompletion ? { degradedCompletion: true, degradedStepIds: input.degradedStepIds } : {}),
    },
  };
}

export function createSkipBatchOutcome(steps: PlannerStep[]): PlannerSkipOutcome {
  return {
    stepUpdates: steps.map((step) => ({
      stepId: step.id,
      updates: { status: 'DONE', executionState: 'done' },
    })),
    events: steps.map((step) => ({
      stepId: step.id,
      kind: step.kind,
      reason: 'Planning-only step',
    })),
  };
}

export function createVerifyFeedbackOutcome(input: {
  planRevision: number;
  step: PlannerStep;
  status: PlannerStepStatus;
  changedFiles: string[];
  message: string;
  stop: boolean;
  executionEpoch: number;
}): PlannerVerifyFeedbackOutcome {
  return {
    feedback: {
      version: '1',
      planRevision: input.planRevision,
      executionEpoch: input.executionEpoch,
      changedFiles: input.changedFiles,
      undeclaredChangedFiles: [],
      verifyFailures: input.stop
        ? [{ stepId: input.step.id, command: '', stderr: input.message }]
        : [],
      lockViolations: [],
      stepSummaries: [{
        stepId: input.step.id,
        title: input.step.title,
        status: input.status,
        changedFiles: input.changedFiles,
        undeclaredChangedFiles: [],
        message: input.stop ? input.message : 'verify passed',
      }],
      triggerReplan: input.stop,
      replanReason: input.stop ? `Verify step ${input.step.id} failed` : '',
    },
    ...(input.stop ? { verifyFailedEvent: { stepId: input.step.id, epoch: input.executionEpoch } } : {}),
  };
}

export function createWaveFeedbackOutcome(input: {
  selectedSteps: PlannerStep[];
  currentPlan: PlannerPlan;
  waveFeedback: PlannerStepExecutionFeedback[];
  changedFiles: string[];
  executionEpoch: number;
  computeUndeclaredChangedFiles: (step: PlannerStep, declared: string[], actual: string[]) => string[];
}): PlannerWaveFeedbackOutcome {
  const stepSummaries: PlannerExecutionFeedbackArtifact['stepSummaries'] = [];
  const allUndeclared: string[] = [];
  for (const stepResult of input.waveFeedback) {
    const step = input.selectedSteps.find((candidate) => candidate.id === stepResult.stepId);
    const currentStep = input.currentPlan.steps.find((candidate) => candidate.id === stepResult.stepId);
    if (!step) {
      continue;
    }
    const declared = [...new Set([...(currentStep?.fileScope ?? []), ...(currentStep?.producesFiles ?? []), ...(currentStep?.relatedFiles ?? [])])];
    const actual = stepResult.changedFiles;
    const undeclared = input.computeUndeclaredChangedFiles(step, declared, actual);
    if (undeclared.length > 0) {
      allUndeclared.push(...undeclared);
    }
    stepSummaries.push({
      stepId: stepResult.stepId,
      title: step.title,
      status: currentStep?.status ?? stepResult.status,
      changedFiles: actual,
      undeclaredChangedFiles: undeclared,
      message: stepResult.message,
    });
  }
  const undeclaredChangedFiles = [...new Set(allUndeclared)];
  return {
    feedback: {
      version: '1',
      planRevision: input.currentPlan.revision,
      executionEpoch: input.executionEpoch,
      changedFiles: input.changedFiles,
      undeclaredChangedFiles,
      verifyFailures: [],
      lockViolations: [],
      stepSummaries,
      triggerReplan: undeclaredChangedFiles.length > 0,
      replanReason: undeclaredChangedFiles.length > 0
        ? `Undeclared changed files detected in wave: ${undeclaredChangedFiles.join(', ')}`
        : '',
    },
    ...(undeclaredChangedFiles.length > 0
      ? {
        replanEvent: {
          epoch: input.executionEpoch,
          undeclaredFiles: undeclaredChangedFiles,
          triggerReplan: true as const,
        },
      }
      : {}),
  };
}

export function selectPlannerReadyQueueBatch(input: {
  plan: PlannerPlan;
  readySteps: PlannerStep[];
  lockTable: ExecutionLockTable;
  strategyMode: PlannerExecutionStrategyMode;
  maxConcurrentSubtasks: number;
  classifyPlannerStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
}): PlannerReadyQueueSelection {
  if (containsReadyFallbackStep(input.plan, input.readySteps)) {
    return { kind: 'defer_legacy_fallback' };
  }

  const skipSteps = input.readySteps.filter((step) => input.classifyPlannerStep(step) === 'skip');
  if (skipSteps.length > 0) {
    return {
      kind: 'selected',
      batch: input.strategyMode === 'deterministic'
        ? [skipSteps[0]].filter((step): step is PlannerStep => Boolean(step))
        : skipSteps.slice(0, Math.max(1, input.maxConcurrentSubtasks)),
    };
  }

  const runtimeState = createPlannerRuntimeState(input.plan);
  const readyIds = new Set(input.readySteps.map((step) => step.id));
  runtimeState.locks = createRuntimeLocksFromExecutionLockTable(input.lockTable);
  const candidateTasks = runtimeState.tasks.filter((task) => readyIds.has(task.stepId));

  const selected = selectRunnableRuntimeBatchFromCandidates(
    candidateTasks,
    effectiveRuntimeMaxConcurrent(input.strategyMode, input.maxConcurrentSubtasks, runtimeState.tasks.length),
    runtimeState.locks,
  );
  if (selected.length === 0 && input.readySteps.length > 0) {
    return { kind: 'blocked_by_runtime_locks' };
  }
  const selectedIds = new Set(selected.map((task) => task.stepId));
  return {
    kind: 'selected',
    batch: input.readySteps.filter((step) => selectedIds.has(step.id)),
  };
}

export function createRuntimeLocksFromExecutionLockTable(lockTable: ExecutionLockTable): PlannerRuntimeLock[] {
  return lockTable.entries
    .filter((entry) => entry.mode === 'write_locked')
    .map((entry) => ({
      path: entry.path,
      ownerTaskId: entry.ownerStepId,
    }));
}

function effectiveRuntimeMaxConcurrent(
  strategyMode: PlannerExecutionStrategyMode,
  maxConcurrentSubtasks: number,
  readyTaskCount: number,
): number {
  if (strategyMode === 'deterministic') {
    return 1;
  }
  if (strategyMode === 'aggressive') {
    return Math.max(maxConcurrentSubtasks, readyTaskCount);
  }
  return Math.max(1, maxConcurrentSubtasks);
}

function containsReadyFallbackStep(plan: PlannerPlan, readySteps: PlannerStep[]): boolean {
  const readyIds = new Set(readySteps.map((step) => step.id));
  return plan.steps.some((step) => (step.fallbackStepIds ?? []).some((fallbackStepId) => readyIds.has(fallbackStepId)));
}
