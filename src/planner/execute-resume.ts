import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from '../provider/types.js';
import type { SessionRecord } from '../session/index.js';
import type { PlannerExecutionArtifacts, PlannerExecutionStateArtifact } from './execution-types.js';
import { buildExecutionGraph } from './graph.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerRequestArtifact, PlannerPlan, PlannerState, PlannerStep } from './types.js';
import { executePlannerPlan } from './execute.js';
import { classifyPlannerStep, updatePlannerStep } from './runtime.js';

type PlannerResumeStrategy = PlannerExecutionStateArtifact['resumeStrategy'] | 'resume_recovering' | 'resume_fallback_path' | 'return_terminal';

interface PlannerResumeDecision {
  strategy: PlannerResumeStrategy;
  stepIdsToReset: string[];
  reason: string;
  recoverySourceStepId?: string;
  recoveryStepId?: string;
  recoverySubgraphStepIds?: string[];
  preserveGuardedLocks?: boolean;
  lockResumeMode?: PlannerExecutionStateArtifact['lockResumeMode'];
  returnExistingState?: boolean;
}

interface PlannerResumeLockOutcome {
  nextLockTable: ExecutionLockTable;
  preservedOwnerStepIds: string[];
  downgradedOwnerStepIds: string[];
  droppedOwnerStepIds: string[];
  mode: NonNullable<PlannerExecutionStateArtifact['lockResumeMode']>;
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
  const lockOutcome = computeResumeLockOutcome(artifacts.lockTable, decision);
  let lockTable = lockOutcome.nextLockTable;

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
      ...(decision.recoverySourceStepId ? { recoverySourceStepId: decision.recoverySourceStepId } : {}),
      ...(decision.recoveryStepId ? { recoveryStepId: decision.recoveryStepId } : {}),
      ...(decision.recoverySubgraphStepIds && decision.recoverySubgraphStepIds.length > 0 ? { recoverySubgraphStepIds: decision.recoverySubgraphStepIds } : {}),
      lockResumeMode: lockOutcome.mode,
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
      const recoverySourceStepId = detectRecoverySourceStepId(artifacts.plan, recoveryStepId, artifacts.executionState.lastEventType);
      const recoverySubgraphStepIds = buildResumeRecoverySubgraphStepIds(artifacts.plan, recoveryStepId, recoverySourceStepId);
      return {
        strategy: artifacts.executionState.lastEventType === 'FALLBACK_ACTIVATED' ? 'resume_fallback_path' : 'resume_recovering',
        stepIdsToReset: [recoveryStepId],
        reason: artifacts.executionState.lastEventType === 'FALLBACK_ACTIVATED'
          ? `continuing fallback recovery through ${recoveryStepId}.`
          : `continuing recovery through ${recoveryStepId}.`,
        ...(recoverySourceStepId ? { recoverySourceStepId } : {}),
        recoveryStepId,
        ...(recoverySubgraphStepIds.length > 0 ? { recoverySubgraphStepIds } : {}),
        preserveGuardedLocks: true,
        lockResumeMode: 'drop_unrelated_writes',
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

function computeResumeLockOutcome(lockTable: ExecutionLockTable, decision: PlannerResumeDecision): PlannerResumeLockOutcome {
  const stepIds = new Set(decision.stepIdsToReset);
  const recoverySubgraph = new Set(decision.recoverySubgraphStepIds ?? []);
  if (stepIds.size === 0 && recoverySubgraph.size === 0) {
    return {
      nextLockTable: lockTable,
      preservedOwnerStepIds: [],
      downgradedOwnerStepIds: [],
      droppedOwnerStepIds: [],
      mode: decision.lockResumeMode ?? 'drop_unrelated_writes',
    };
  }

  const preservedOwnerStepIds = new Set<string>();
  const downgradedOwnerStepIds = new Set<string>();
  const droppedOwnerStepIds = new Set<string>();

  const nextEntries = lockTable.entries
    .filter((entry) => {
      if (entry.mode !== 'write_locked') {
        preservedOwnerStepIds.add(entry.ownerStepId);
        return true;
      }
      const belongsToRecovery = stepIds.has(entry.ownerStepId) || recoverySubgraph.has(entry.ownerStepId);
      if (!belongsToRecovery) {
        droppedOwnerStepIds.add(entry.ownerStepId);
      }
      return belongsToRecovery;
    })
    .map((entry) => {
      if (entry.mode === 'write_locked' && (stepIds.has(entry.ownerStepId) || recoverySubgraph.has(entry.ownerStepId))) {
        downgradedOwnerStepIds.add(entry.ownerStepId);
        return { ...entry, mode: 'guarded_read' as const };
      }
      return entry;
    });

  return {
    nextLockTable: {
      ...lockTable,
      entries: nextEntries,
    },
    preservedOwnerStepIds: [...preservedOwnerStepIds],
    downgradedOwnerStepIds: [...downgradedOwnerStepIds],
    droppedOwnerStepIds: [...droppedOwnerStepIds],
    mode: decision.lockResumeMode ?? 'drop_unrelated_writes',
  };
}

function shouldPreserveCurrentWave(strategy: PlannerResumeDecision['strategy']): boolean {
  return strategy === 'resume_recovering' || strategy === 'resume_fallback_path';
}

function detectRecoverySourceStepId(
  plan: PlannerPlan,
  recoveryStepId: string,
  lastEventType: PlannerExecutionStateArtifact['lastEventType'],
): string {
  if (lastEventType !== 'FALLBACK_ACTIVATED') {
    return '';
  }

  return plan.steps.find((step) => step.fallbackStepIds?.includes(recoveryStepId))?.id ?? '';
}

function buildResumeRecoverySubgraphStepIds(
  plan: PlannerPlan,
  recoveryStepId: string,
  recoverySourceStepId: string,
): string[] {
  const graph = buildExecutionGraph(plan);
  const seeds = [recoveryStepId, recoverySourceStepId].filter(Boolean);
  const visited = new Set<string>();
  const queue = [...seeds];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }
    const step = plan.steps.find((candidate) => candidate.id === current);
    if (!step || step.status === 'DONE') {
      continue;
    }
    visited.add(current);
    for (const edge of graph.edges) {
      if (!executeResumeIsScopedEdge(edge.type)) {
        continue;
      }
      if (edge.from === current && !visited.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  return [...visited];
}

function executeResumeIsScopedEdge(type: string): boolean {
  return type === 'dependency' || type === 'must_run_after' || type === 'fallback';
}
