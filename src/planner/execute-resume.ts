import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from '../provider/types.js';
import type { SessionRecord } from '../session/index.js';
import type { PlannerExecutionArtifacts } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerRequestArtifact, PlannerPlan, PlannerState, PlannerStep } from './types.js';
import { executePlannerPlan } from './execute.js';
import { classifyPlannerStep, updatePlannerStep } from './runtime.js';

export async function resumePlannerExecution(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  artifacts: PlannerExecutionArtifacts,
): Promise<{ plan: PlannerPlan; state: PlannerState }> {
  const decision = classifyResumeDecision(artifacts);
  let plan = artifacts.plan;
  let state = artifacts.state;
  let lockTable = prepareLockTableForResume(artifacts.lockTable, decision.stepIdsToReset);

  if (decision.stepIdsToReset.length > 0) {
    for (const stepId of decision.stepIdsToReset) {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.status === 'DONE' || shouldPreserveStepOnResume(step)) {
        continue;
      }
      plan = updatePlannerStep(plan, stepId, {
        status: 'PENDING',
        executionState: 'idle',
        lastError: `Interrupted during ${artifacts.executionState.executionPhase}; ${decision.reason}`,
        details: `Interrupted during ${artifacts.executionState.executionPhase}; ${decision.reason}`,
      });
    }
    state = {
      ...state,
      phase: 'RETRYING',
      outcome: 'RUNNING',
      failedStepIds: [],
      blockedStepIds: [],
      activeStepIds: [],
      readyStepIds: [],
      message: decision.stepIdsToReset.length === 1
        ? `Resuming interrupted execution for ${decision.stepIdsToReset[0]}.`
        : `Resuming interrupted execution for ${decision.stepIdsToReset.join(', ')}.`,
    };
  }

  return executePlannerPlan(config, providers, session, requestArtifact, plan, state, {
    classifyPlannerStep,
    updatePlannerStep,
  }, {
    lockTable,
    executionState: {
      ...artifacts.executionState,
      resumeStrategy: decision.strategy,
      interruptedStepIds: decision.stepIdsToReset,
      currentWaveStepIds: decision.strategy === 'rerun_active' ? decision.stepIdsToReset : [],
      lastEventReason: decision.reason,
    },
  });
}

function shouldPreserveStepOnResume(step: PlannerStep): boolean {
  return step.failureTolerance === 'degrade' && step.status === 'FAILED';
}

function classifyResumeDecision(artifacts: PlannerExecutionArtifacts): {
  strategy: 'continue_wave' | 'rerun_active' | 'rerun_ready' | 'rebuild_from_plan';
  stepIdsToReset: string[];
  reason: string;
} {
  const currentWaveStepIds = artifacts.executionState.currentWaveStepIds ?? [];
  const activeStepIds = artifacts.executionState.activeStepIds ?? [];
  const readyStepIds = artifacts.executionState.readyStepIds ?? [];
  const pendingStepIds = artifacts.plan.steps
    .filter((step) => step.status !== 'DONE' && !shouldPreserveStepOnResume(step))
    .map((step) => step.id);

  if (currentWaveStepIds.length > 0) {
    return {
      strategy: 'rerun_active',
      stepIdsToReset: currentWaveStepIds,
      reason: 'resuming the interrupted active wave.',
    };
  }

  if (activeStepIds.length > 0) {
    return {
      strategy: 'rerun_active',
      stepIdsToReset: activeStepIds,
      reason: 'resuming interrupted active steps.',
    };
  }

  if (readyStepIds.length > 0) {
    return {
      strategy: 'rerun_ready',
      stepIdsToReset: readyStepIds,
      reason: 're-running ready steps from the last persisted snapshot.',
    };
  }

  return {
    strategy: 'rebuild_from_plan',
    stepIdsToReset: pendingStepIds,
    reason: 'rebuilding runnable steps from the persisted plan.',
  };
}

function prepareLockTableForResume(lockTable: ExecutionLockTable, stepIdsToReset: string[]): ExecutionLockTable {
  if (stepIdsToReset.length === 0) {
    return lockTable;
  }

  const stepIds = new Set(stepIdsToReset);
  return {
    ...lockTable,
    entries: lockTable.entries
      .map((entry) => (stepIds.has(entry.ownerStepId) && entry.mode === 'write_locked'
        ? { ...entry, mode: 'guarded_read' as const }
        : entry)),
  };
}
