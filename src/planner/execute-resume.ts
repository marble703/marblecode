import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from '../provider/types.js';
import type { SessionRecord } from '../session/index.js';
import type { PlannerExecutionArtifacts, PlannerExecutionStateArtifact } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerRequestArtifact, PlannerPlan, PlannerState, PlannerStep } from './types.js';
import { executePlannerPlan } from './execute.js';
import { classifyPlannerStep, updatePlannerStep } from './runtime.js';

type PlannerResumeStrategy = PlannerExecutionStateArtifact['resumeStrategy'] | 'resume_recovering' | 'resume_fallback_path' | 'return_terminal';

interface PlannerResumeDecision {
  strategy: PlannerResumeStrategy;
  stepIdsToReset: string[];
  reason: string;
  recoveryStepId?: string;
  returnExistingState?: boolean;
}

export async function resumePlannerExecution(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  artifacts: PlannerExecutionArtifacts,
): Promise<{ plan: PlannerPlan; state: PlannerState }> {
  const decision = classifyResumeDecision(artifacts);
  if (decision.returnExistingState) {
    return {
      plan: artifacts.plan,
      state: artifacts.state,
    };
  }

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
      ...(decision.strategy ? { resumeStrategy: decision.strategy } : {}),
      interruptedStepIds: decision.stepIdsToReset,
      currentWaveStepIds: shouldPreserveCurrentWave(decision.strategy)
        ? artifacts.executionState.currentWaveStepIds
        : decision.strategy === 'rerun_active'
          ? decision.stepIdsToReset
          : [],
      ...(decision.recoveryStepId ? { recoveryStepId: decision.recoveryStepId } : {}),
      lastEventReason: decision.reason,
    },
  });
}

function shouldPreserveStepOnResume(step: PlannerStep): boolean {
  return step.failureTolerance === 'degrade' && step.status === 'FAILED';
}

function classifyResumeDecision(artifacts: PlannerExecutionArtifacts): PlannerResumeDecision {
  if (artifacts.executionState.executionPhase === 'done' || artifacts.state.outcome === 'DONE') {
    return {
      strategy: 'return_terminal',
      stepIdsToReset: [],
      reason: 'execution already completed.',
      returnExistingState: true,
    };
  }

  if (artifacts.executionState.executionPhase === 'failed' || artifacts.state.outcome === 'FAILED') {
    return {
      strategy: 'return_terminal',
      stepIdsToReset: [],
      reason: 'execution already failed and needs explicit new input.',
      returnExistingState: true,
    };
  }

  const currentWaveStepIds = artifacts.executionState.currentWaveStepIds ?? [];
  const activeStepIds = artifacts.executionState.activeStepIds ?? [];
  const readyStepIds = artifacts.executionState.readyStepIds ?? [];
  const recoveryStepId = typeof artifacts.executionState.recoveryStepId === 'string' && artifacts.executionState.recoveryStepId
    ? artifacts.executionState.recoveryStepId
    : '';

  if (artifacts.executionState.executionPhase === 'recovering' && recoveryStepId) {
    const recoveryStep = artifacts.plan.steps.find((step) => step.id === recoveryStepId);
    if (recoveryStep && recoveryStep.status !== 'DONE') {
      return {
        strategy: artifacts.executionState.lastEventType === 'FALLBACK_ACTIVATED' ? 'resume_fallback_path' : 'resume_recovering',
        stepIdsToReset: [recoveryStepId],
        reason: artifacts.executionState.lastEventType === 'FALLBACK_ACTIVATED'
          ? `continuing fallback recovery through ${recoveryStepId}.`
          : `continuing recovery through ${recoveryStepId}.`,
        recoveryStepId,
      };
    }
  }

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

function shouldPreserveCurrentWave(strategy: PlannerResumeDecision['strategy']): boolean {
  return strategy === 'resume_recovering' || strategy === 'resume_fallback_path';
}
