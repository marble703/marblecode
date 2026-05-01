import { selectRunnableRuntimeBatchFromCandidates } from './execution-scheduler.js';
import { createPlannerRuntimeState } from './execution-runtime-state.js';
import type { PlannerRuntimeLock } from './execution-runtime-types.js';
import type { PlannerExecutionStrategyMode } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerPlan, PlannerStep } from './types.js';

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
