import type { PlannerExecutionStateArtifact, PlannerExecutionStrategyMode } from './execution-types.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerState } from './types.js';
import type { PlannerExecutionSnapshotInput } from './execution-machine.js';

export interface PersistedRecoverySnapshotFields {
  resumeStrategy?: PlannerExecutionStateArtifact['resumeStrategy'];
  preservedLockOwnerStepIds?: string[];
  reusedLockOwnerStepIds?: string[];
  downgradedLockOwnerStepIds?: string[];
  droppedLockOwnerStepIds?: string[];
  recoverySourceStepId?: string;
  recoverySubgraphStepIds?: string[];
  lockResumeMode?: PlannerExecutionStateArtifact['lockResumeMode'];
  recoveryStepId?: string;
  recoveryReason?: string;
}

export interface ExecutionRuntimeCursor {
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  selectedWaveStepIds: string[];
  interruptedStepIds: string[];
  epoch: number;
  planningWindowState: PlannerExecutionStateArtifact['planningWindowState'] | '';
}

export interface InitialExecutionRuntimeContext {
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
  planningWindowState: NonNullable<PlannerExecutionStateArtifact['planningWindowState']> | '';
  reusedLockOwnerStepIds: string[];
  preservedLockOwnerStepIds: string[];
  downgradedLockOwnerStepIds: string[];
  droppedLockOwnerStepIds: string[];
  recoveryStepId: string | null;
  recoveryReason: string;
  lastEventReason: string;
  resumeStrategy: PlannerExecutionStateArtifact['resumeStrategy'] | undefined;
}

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
    reusedLockOwnerStepIds?: string[];
    downgradedLockOwnerStepIds?: string[];
    droppedLockOwnerStepIds?: string[];
    recoverySourceStepId?: string;
    recoverySubgraphStepIds?: string[];
    lockResumeMode?: PlannerExecutionStateArtifact['lockResumeMode'];
    planningWindowState?: PlannerExecutionStateArtifact['planningWindowState'];
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
    ...(extras?.reusedLockOwnerStepIds && extras.reusedLockOwnerStepIds.length > 0 ? { reusedLockOwnerStepIds: extras.reusedLockOwnerStepIds } : {}),
    ...(extras?.downgradedLockOwnerStepIds && extras.downgradedLockOwnerStepIds.length > 0 ? { downgradedLockOwnerStepIds: extras.downgradedLockOwnerStepIds } : {}),
    ...(extras?.droppedLockOwnerStepIds && extras.droppedLockOwnerStepIds.length > 0 ? { droppedLockOwnerStepIds: extras.droppedLockOwnerStepIds } : {}),
    ...(extras?.recoverySourceStepId ? { recoverySourceStepId: extras.recoverySourceStepId } : {}),
    ...(extras?.recoverySubgraphStepIds && extras.recoverySubgraphStepIds.length > 0 ? { recoverySubgraphStepIds: extras.recoverySubgraphStepIds } : {}),
    ...(extras?.lockResumeMode ? { lockResumeMode: extras.lockResumeMode } : {}),
    ...(extras?.planningWindowState ? { planningWindowState: extras.planningWindowState } : {}),
    ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
    ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
  };
}

export function summarizeActiveLockOwners(lockTable: ExecutionLockTable): string[] {
  return [...new Set(lockTable.entries.filter((entry) => entry.mode === 'write_locked').map((entry) => entry.ownerStepId))];
}

export function copyPersistedRecoverySnapshot(executionState: PlannerExecutionStateArtifact): PersistedRecoverySnapshotFields {
  return {
    ...(executionState.resumeStrategy ? { resumeStrategy: executionState.resumeStrategy } : {}),
    ...(executionState.preservedLockOwnerStepIds ? { preservedLockOwnerStepIds: executionState.preservedLockOwnerStepIds } : {}),
    ...(executionState.reusedLockOwnerStepIds ? { reusedLockOwnerStepIds: executionState.reusedLockOwnerStepIds } : {}),
    ...(executionState.downgradedLockOwnerStepIds ? { downgradedLockOwnerStepIds: executionState.downgradedLockOwnerStepIds } : {}),
    ...(executionState.droppedLockOwnerStepIds ? { droppedLockOwnerStepIds: executionState.droppedLockOwnerStepIds } : {}),
    ...(executionState.recoverySourceStepId ? { recoverySourceStepId: executionState.recoverySourceStepId } : {}),
    ...(executionState.recoverySubgraphStepIds ? { recoverySubgraphStepIds: executionState.recoverySubgraphStepIds } : {}),
    ...(executionState.lockResumeMode ? { lockResumeMode: executionState.lockResumeMode } : {}),
    ...(executionState.recoveryStepId ? { recoveryStepId: executionState.recoveryStepId } : {}),
    ...(executionState.recoveryReason ? { recoveryReason: executionState.recoveryReason } : {}),
  };
}

export function createInitialExecutionRuntimeCursor(initialRuntime: InitialExecutionRuntimeContext): ExecutionRuntimeCursor {
  return {
    currentWaveStepIds: initialRuntime.currentWaveStepIds,
    lastCompletedWaveStepIds: initialRuntime.lastCompletedWaveStepIds,
    selectedWaveStepIds: initialRuntime.selectedWaveStepIds,
    interruptedStepIds: initialRuntime.interruptedStepIds,
    epoch: initialRuntime.executionEpoch,
    planningWindowState: initialRuntime.planningWindowState,
  };
}

export function markWaveSelected(cursor: ExecutionRuntimeCursor, stepIds: string[]): ExecutionRuntimeCursor {
  return {
    ...cursor,
    currentWaveStepIds: stepIds,
    selectedWaveStepIds: stepIds,
    interruptedStepIds: stepIds,
    epoch: cursor.epoch + 1,
  };
}

export function clearInterruptedWave(cursor: ExecutionRuntimeCursor): ExecutionRuntimeCursor {
  return {
    ...cursor,
    currentWaveStepIds: [],
    interruptedStepIds: [],
  };
}

export function markWaveCompleted(cursor: ExecutionRuntimeCursor): ExecutionRuntimeCursor {
  return {
    ...cursor,
    lastCompletedWaveStepIds: cursor.currentWaveStepIds,
    currentWaveStepIds: [],
    interruptedStepIds: [],
  };
}

export function markRecoveryFallback(cursor: ExecutionRuntimeCursor, fallbackStepIds: string[]): ExecutionRuntimeCursor {
  return {
    ...cursor,
    currentWaveStepIds: [],
    interruptedStepIds: fallbackStepIds,
  };
}

export function markPlanningWindowCompleted(cursor: ExecutionRuntimeCursor): ExecutionRuntimeCursor {
  return {
    ...cursor,
    planningWindowState: 'completed_waiting_append',
  };
}

export function buildInitialExecutionStateExtras(
  runtimeCursor: ExecutionRuntimeCursor,
  initialRuntime: InitialExecutionRuntimeContext,
): Omit<PlannerExecutionSnapshotInput, 'state' | 'strategy'> {
  return {
    currentWaveStepIds: runtimeCursor.currentWaveStepIds,
    lastCompletedWaveStepIds: runtimeCursor.lastCompletedWaveStepIds,
    epoch: runtimeCursor.epoch,
    ...(runtimeCursor.selectedWaveStepIds.length > 0 ? { selectedWaveStepIds: runtimeCursor.selectedWaveStepIds } : {}),
    ...(initialRuntime.resumeStrategy ? { resumeStrategy: initialRuntime.resumeStrategy } : {}),
    ...(runtimeCursor.interruptedStepIds.length > 0 ? { interruptedStepIds: runtimeCursor.interruptedStepIds } : {}),
    ...(initialRuntime.lastEventReason ? { lastEventReason: initialRuntime.lastEventReason } : {}),
    ...(initialRuntime.activeLockOwnerStepIds.length > 0 ? { activeLockOwnerStepIds: initialRuntime.activeLockOwnerStepIds } : {}),
    ...(initialRuntime.preservedLockOwnerStepIds.length > 0 ? { preservedLockOwnerStepIds: initialRuntime.preservedLockOwnerStepIds } : {}),
    ...(initialRuntime.reusedLockOwnerStepIds.length > 0 ? { reusedLockOwnerStepIds: initialRuntime.reusedLockOwnerStepIds } : {}),
    ...(initialRuntime.downgradedLockOwnerStepIds.length > 0 ? { downgradedLockOwnerStepIds: initialRuntime.downgradedLockOwnerStepIds } : {}),
    ...(initialRuntime.droppedLockOwnerStepIds.length > 0 ? { droppedLockOwnerStepIds: initialRuntime.droppedLockOwnerStepIds } : {}),
    ...(initialRuntime.recoverySourceStepId ? { recoverySourceStepId: initialRuntime.recoverySourceStepId } : {}),
    ...(initialRuntime.recoverySubgraphStepIds.length > 0 ? { recoverySubgraphStepIds: initialRuntime.recoverySubgraphStepIds } : {}),
    ...(initialRuntime.lockResumeMode ? { lockResumeMode: initialRuntime.lockResumeMode } : {}),
    ...(runtimeCursor.planningWindowState ? { planningWindowState: runtimeCursor.planningWindowState } : {}),
    ...(initialRuntime.recoveryStepId ? { recoveryStepId: initialRuntime.recoveryStepId } : {}),
    ...(initialRuntime.recoveryReason ? { recoveryReason: initialRuntime.recoveryReason } : {}),
  };
}

export function buildExecutionDispatchSnapshot(input: {
  state: PlannerState;
  strategy: PlannerExecutionStrategyMode;
  lockTable: ExecutionLockTable;
  executionState: PlannerExecutionStateArtifact;
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  selectedWaveStepIds: string[];
  interruptedStepIds: string[];
  epoch: number;
  planningWindowState: PlannerExecutionStateArtifact['planningWindowState'] | '';
  recoveryStepId?: string;
  recoveryReason?: string;
}): PlannerExecutionSnapshotInput {
  const persistedRecovery = copyPersistedRecoverySnapshot(input.executionState);
  return {
    state: input.state,
    strategy: input.strategy,
    currentWaveStepIds: input.currentWaveStepIds,
    lastCompletedWaveStepIds: input.lastCompletedWaveStepIds,
    epoch: input.epoch,
    ...(input.selectedWaveStepIds.length > 0 ? { selectedWaveStepIds: input.selectedWaveStepIds } : {}),
    ...(input.interruptedStepIds.length > 0 ? { interruptedStepIds: input.interruptedStepIds } : {}),
    ...(summarizeActiveLockOwners(input.lockTable).length > 0 ? { activeLockOwnerStepIds: summarizeActiveLockOwners(input.lockTable) } : {}),
    ...persistedRecovery,
    ...(input.planningWindowState ? { planningWindowState: input.planningWindowState } : {}),
    ...(input.recoveryReason ? { lastEventReason: input.recoveryReason } : {}),
    ...(input.recoveryStepId ? { recoveryStepId: input.recoveryStepId } : {}),
    ...(input.recoveryReason ? { recoveryReason: input.recoveryReason } : {}),
  };
}

export function buildInitialExecutionRuntimeContext(
  lockTable: ExecutionLockTable,
  executionState?: PlannerExecutionStateArtifact,
): InitialExecutionRuntimeContext {
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
    planningWindowState: executionState?.planningWindowState ?? '',
    reusedLockOwnerStepIds: executionState?.reusedLockOwnerStepIds ?? [],
    preservedLockOwnerStepIds: executionState?.preservedLockOwnerStepIds ?? [],
    downgradedLockOwnerStepIds: executionState?.downgradedLockOwnerStepIds ?? [],
    droppedLockOwnerStepIds: executionState?.droppedLockOwnerStepIds ?? [],
    recoveryStepId: executionState?.recoveryStepId ?? null,
    recoveryReason: executionState?.recoveryReason ?? '',
    lastEventReason: executionState?.lastEventReason ?? '',
    resumeStrategy: executionState?.resumeStrategy,
  };
}
