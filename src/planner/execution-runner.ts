import { selectRunnableRuntimeBatchFromCandidates } from './execution-scheduler.js';
import { createPlannerRuntimeState } from './execution-runtime-state.js';
import type { PlannerRuntimeLock } from './execution-runtime-types.js';
import type { PlannerExecutionStrategyMode } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerPlan, PlannerStep } from './types.js';

export function selectPlannerReadyQueueBatch(input: {
  plan: PlannerPlan;
  readySteps: PlannerStep[];
  lockTable: ExecutionLockTable;
  strategyMode: PlannerExecutionStrategyMode;
  maxConcurrentSubtasks: number;
  classifyPlannerStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
}): PlannerStep[] {
  if (containsReadyFallbackStep(input.plan, input.readySteps)) {
    return [];
  }

  const skipSteps = input.readySteps.filter((step) => input.classifyPlannerStep(step) === 'skip');
  if (skipSteps.length > 0) {
    return input.strategyMode === 'deterministic'
      ? [skipSteps[0]].filter((step): step is PlannerStep => Boolean(step))
      : skipSteps.slice(0, Math.max(1, input.maxConcurrentSubtasks));
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
  const selectedIds = new Set(selected.map((task) => task.stepId));
  return input.readySteps.filter((step) => selectedIds.has(step.id));
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
