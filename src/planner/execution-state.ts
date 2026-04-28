import type { PlannerExecutionStateArtifact, PlannerExecutionStrategyMode } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerState } from './types.js';

export function createPlannerExecutionState(
  state: PlannerState,
  strategy: PlannerExecutionStrategyMode,
  executionPhase: PlannerExecutionStateArtifact['executionPhase'],
  extras?: {
    currentWaveStepIds?: string[];
    lastCompletedWaveStepIds?: string[];
    epoch?: number;
    selectedWaveStepIds?: string[];
    resumeStrategy?: PlannerExecutionStateArtifact['resumeStrategy'];
    interruptedStepIds?: string[];
    lastEventType?: PlannerExecutionStateArtifact['lastEventType'];
    lastEventReason?: string;
    activeLockOwnerStepIds?: string[];
    preservedLockOwnerStepIds?: string[];
    downgradedLockOwnerStepIds?: string[];
    droppedLockOwnerStepIds?: string[];
    recoverySourceStepId?: string;
    recoverySubgraphStepIds?: string[];
    lockResumeMode?: PlannerExecutionStateArtifact['lockResumeMode'];
    recoveryStepId?: string;
    recoveryReason?: string;
  },
): PlannerExecutionStateArtifact {
  return {
    version: '1',
    revision: state.revision,
    executionPhase,
    plannerPhase: state.phase,
    outcome: state.outcome,
    activeStepIds: state.activeStepIds,
    readyStepIds: state.readyStepIds,
    completedStepIds: state.completedStepIds,
    failedStepIds: state.failedStepIds,
    blockedStepIds: state.blockedStepIds,
    degradedStepIds: state.degradedStepIds ?? [],
    currentWaveStepIds: extras?.currentWaveStepIds ?? [],
    lastCompletedWaveStepIds: extras?.lastCompletedWaveStepIds ?? [],
    ...(extras?.selectedWaveStepIds ? { selectedWaveStepIds: extras.selectedWaveStepIds } : {}),
    strategy,
    epoch: extras?.epoch ?? 0,
    currentStepId: state.currentStepId,
    message: state.message,
    ...(extras?.resumeStrategy ? { resumeStrategy: extras.resumeStrategy } : {}),
    ...(extras?.interruptedStepIds && extras.interruptedStepIds.length > 0 ? { interruptedStepIds: extras.interruptedStepIds } : {}),
    ...(extras?.lastEventType ? { lastEventType: extras.lastEventType } : {}),
    ...(extras?.lastEventReason ? { lastEventReason: extras.lastEventReason } : {}),
    ...(extras?.activeLockOwnerStepIds && extras.activeLockOwnerStepIds.length > 0 ? { activeLockOwnerStepIds: extras.activeLockOwnerStepIds } : {}),
    ...(extras?.preservedLockOwnerStepIds && extras.preservedLockOwnerStepIds.length > 0 ? { preservedLockOwnerStepIds: extras.preservedLockOwnerStepIds } : {}),
    ...(extras?.downgradedLockOwnerStepIds && extras.downgradedLockOwnerStepIds.length > 0 ? { downgradedLockOwnerStepIds: extras.downgradedLockOwnerStepIds } : {}),
    ...(extras?.droppedLockOwnerStepIds && extras.droppedLockOwnerStepIds.length > 0 ? { droppedLockOwnerStepIds: extras.droppedLockOwnerStepIds } : {}),
    ...(extras?.recoverySourceStepId ? { recoverySourceStepId: extras.recoverySourceStepId } : {}),
    ...(extras?.recoverySubgraphStepIds && extras.recoverySubgraphStepIds.length > 0 ? { recoverySubgraphStepIds: extras.recoverySubgraphStepIds } : {}),
    ...(extras?.lockResumeMode ? { lockResumeMode: extras.lockResumeMode } : {}),
    ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
    ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
  };
}

export function summarizeActiveLockOwners(lockTable: ExecutionLockTable): string[] {
  return [...new Set(lockTable.entries.filter((entry) => entry.mode === 'write_locked').map((entry) => entry.ownerStepId))];
}

export function buildInitialExecutionRuntimeContext(
  lockTable: ExecutionLockTable,
  executionState?: PlannerExecutionStateArtifact,
): {
  lockTable: ExecutionLockTable;
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  selectedWaveStepIds: string[];
  interruptedStepIds: string[];
  executionEpoch: number;
  activeLockOwnerStepIds: string[];
  recoverySourceStepId: string | null;
  recoverySubgraphStepIds: string[];
  lockResumeMode: NonNullable<PlannerExecutionStateArtifact['lockResumeMode']> | '';
} {
  return {
    lockTable,
    currentWaveStepIds: executionState?.currentWaveStepIds ?? [],
    lastCompletedWaveStepIds: executionState?.lastCompletedWaveStepIds ?? [],
    selectedWaveStepIds: executionState?.selectedWaveStepIds ?? [],
    interruptedStepIds: executionState?.interruptedStepIds ?? [],
    executionEpoch: executionState?.epoch ?? 0,
    activeLockOwnerStepIds: summarizeActiveLockOwners(lockTable),
    recoverySourceStepId: executionState?.recoverySourceStepId ?? null,
    recoverySubgraphStepIds: executionState?.recoverySubgraphStepIds ?? [],
    lockResumeMode: executionState?.lockResumeMode ?? '',
  };
}
