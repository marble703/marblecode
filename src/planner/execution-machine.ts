import type { SessionRecord } from '../session/index.js';
import { writePlannerExecutionArtifacts } from './artifacts.js';
import { createPlannerExecutionState } from './execution-state.js';
import type { PlannerExecutionGraph } from './graph.js';
import type { ExecutionLockTable } from './locks.js';
import type {
  PlannerExecutionEventType,
  PlannerExecutionPhase,
  PlannerExecutionStateArtifact,
  PlannerExecutionStrategyMode,
} from './execution-types.js';
import type { PlannerState } from './types.js';

export type PlannerExecutionEvent =
  | { type: 'EXECUTION_INITIALIZED' }
  | { type: 'CONFLICT_DETECTED' }
  | { type: 'DEPENDENCIES_BLOCKED' }
  | { type: 'SKIP_WAVE_COMPLETED' }
  | { type: 'VERIFY_STEP_STARTED' }
  | { type: 'VERIFY_STEP_SUCCEEDED' }
  | { type: 'VERIFY_STEP_FAILED' }
  | { type: 'LOCKS_ACQUIRED' }
  | { type: 'WAVE_EXECUTED' }
  | { type: 'WAVE_REPLANNED' }
  | { type: 'FALLBACK_ACTIVATED' }
  | { type: 'WAVE_FAILED' }
  | { type: 'WAVE_CONVERGED' }
  | { type: 'EXECUTION_COMPLETED' };

export interface PlannerExecutionSnapshotInput {
  state: PlannerState;
  strategy: PlannerExecutionStrategyMode;
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  epoch: number;
  selectedWaveStepIds?: string[];
  resumeStrategy?: PlannerExecutionStateArtifact['resumeStrategy'];
  interruptedStepIds?: string[];
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
  blockedReasons?: PlannerExecutionStateArtifact['blockedReasons'];
  latestConflict?: PlannerExecutionStateArtifact['latestConflict'];
}

const TRANSITIONS: Partial<Record<PlannerExecutionPhase, Partial<Record<PlannerExecutionEvent['type'], PlannerExecutionPhase>>>> = {
  idle: {
    EXECUTION_INITIALIZED: 'planning',
  },
  planning: {
    CONFLICT_DETECTED: 'failed',
    DEPENDENCIES_BLOCKED: 'failed',
    SKIP_WAVE_COMPLETED: 'converging',
    VERIFY_STEP_STARTED: 'executing_wave',
    LOCKS_ACQUIRED: 'locking',
    EXECUTION_COMPLETED: 'done',
  },
  converging: {
    CONFLICT_DETECTED: 'failed',
    DEPENDENCIES_BLOCKED: 'failed',
    SKIP_WAVE_COMPLETED: 'converging',
    VERIFY_STEP_STARTED: 'executing_wave',
    LOCKS_ACQUIRED: 'locking',
    EXECUTION_COMPLETED: 'done',
  },
  locking: {
    WAVE_EXECUTED: 'executing_wave',
    WAVE_REPLANNED: 'recovering',
    FALLBACK_ACTIVATED: 'recovering',
  },
  executing_wave: {
    VERIFY_STEP_SUCCEEDED: 'converging',
    VERIFY_STEP_FAILED: 'failed',
    WAVE_CONVERGED: 'converging',
    WAVE_REPLANNED: 'recovering',
    FALLBACK_ACTIVATED: 'recovering',
    WAVE_FAILED: 'failed',
    EXECUTION_COMPLETED: 'done',
  },
  recovering: {
    CONFLICT_DETECTED: 'failed',
    DEPENDENCIES_BLOCKED: 'failed',
    WAVE_REPLANNED: 'recovering',
    FALLBACK_ACTIVATED: 'recovering',
    SKIP_WAVE_COMPLETED: 'converging',
    VERIFY_STEP_STARTED: 'executing_wave',
    LOCKS_ACQUIRED: 'locking',
    EXECUTION_COMPLETED: 'done',
  },
};

export function transitionExecutionPhase(
  phase: PlannerExecutionPhase,
  event: PlannerExecutionEvent,
): PlannerExecutionPhase {
  const next = TRANSITIONS[phase]?.[event.type];
  if (!next) {
    throw new Error(`Invalid execution transition: ${phase} -> ${event.type}`);
  }
  return next;
}

export function createInitialExecutionState(
  state: PlannerState,
  strategy: PlannerExecutionStrategyMode,
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
    blockedReasons?: PlannerExecutionStateArtifact['blockedReasons'];
    latestConflict?: PlannerExecutionStateArtifact['latestConflict'];
  },
): PlannerExecutionStateArtifact {
  return createPlannerExecutionState(state, strategy, 'idle', {
    ...(extras?.currentWaveStepIds ? { currentWaveStepIds: extras.currentWaveStepIds } : {}),
    ...(extras?.lastCompletedWaveStepIds ? { lastCompletedWaveStepIds: extras.lastCompletedWaveStepIds } : {}),
    ...(typeof extras?.epoch === 'number' ? { epoch: extras.epoch } : {}),
    ...(extras?.selectedWaveStepIds ? { selectedWaveStepIds: extras.selectedWaveStepIds } : {}),
    ...(extras?.resumeStrategy ? { resumeStrategy: extras.resumeStrategy } : {}),
    ...(extras?.interruptedStepIds ? { interruptedStepIds: extras.interruptedStepIds } : {}),
    ...(extras?.lastEventType ? { lastEventType: extras.lastEventType } : {}),
    ...(extras?.lastEventReason ? { lastEventReason: extras.lastEventReason } : {}),
    ...(extras?.activeLockOwnerStepIds ? { activeLockOwnerStepIds: extras.activeLockOwnerStepIds } : {}),
    ...(extras?.preservedLockOwnerStepIds ? { preservedLockOwnerStepIds: extras.preservedLockOwnerStepIds } : {}),
    ...(extras?.reusedLockOwnerStepIds ? { reusedLockOwnerStepIds: extras.reusedLockOwnerStepIds } : {}),
    ...(extras?.downgradedLockOwnerStepIds ? { downgradedLockOwnerStepIds: extras.downgradedLockOwnerStepIds } : {}),
    ...(extras?.droppedLockOwnerStepIds ? { droppedLockOwnerStepIds: extras.droppedLockOwnerStepIds } : {}),
    ...(extras?.recoverySourceStepId ? { recoverySourceStepId: extras.recoverySourceStepId } : {}),
    ...(extras?.recoverySubgraphStepIds ? { recoverySubgraphStepIds: extras.recoverySubgraphStepIds } : {}),
    ...(extras?.lockResumeMode ? { lockResumeMode: extras.lockResumeMode } : {}),
    ...(extras?.planningWindowState ? { planningWindowState: extras.planningWindowState } : {}),
    ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
    ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
    ...(extras?.blockedReasons ? { blockedReasons: extras.blockedReasons } : {}),
    ...(extras?.latestConflict ? { latestConflict: extras.latestConflict } : {}),
  });
}

export async function dispatchExecutionEvent(
  session: SessionRecord,
  graph: PlannerExecutionGraph,
  lockTable: ExecutionLockTable,
  previous: PlannerExecutionStateArtifact,
  event: PlannerExecutionEvent,
  input: PlannerExecutionSnapshotInput,
): Promise<PlannerExecutionStateArtifact> {
  const nextPhase = transitionExecutionPhase(previous.executionPhase, event);
  const next = createPlannerExecutionState(input.state, input.strategy, nextPhase, {
    currentWaveStepIds: input.currentWaveStepIds,
    lastCompletedWaveStepIds: input.lastCompletedWaveStepIds,
    epoch: input.epoch,
    ...(input.selectedWaveStepIds ? { selectedWaveStepIds: input.selectedWaveStepIds } : {}),
    ...(input.resumeStrategy ? { resumeStrategy: input.resumeStrategy } : {}),
    ...(input.interruptedStepIds ? { interruptedStepIds: input.interruptedStepIds } : {}),
    lastEventType: event.type as PlannerExecutionEventType,
    ...(input.lastEventReason ? { lastEventReason: input.lastEventReason } : {}),
    ...(input.activeLockOwnerStepIds ? { activeLockOwnerStepIds: input.activeLockOwnerStepIds } : {}),
    ...(input.preservedLockOwnerStepIds ? { preservedLockOwnerStepIds: input.preservedLockOwnerStepIds } : {}),
    ...(input.reusedLockOwnerStepIds ? { reusedLockOwnerStepIds: input.reusedLockOwnerStepIds } : {}),
    ...(input.downgradedLockOwnerStepIds ? { downgradedLockOwnerStepIds: input.downgradedLockOwnerStepIds } : {}),
    ...(input.droppedLockOwnerStepIds ? { droppedLockOwnerStepIds: input.droppedLockOwnerStepIds } : {}),
    ...(input.recoverySourceStepId ? { recoverySourceStepId: input.recoverySourceStepId } : {}),
    ...(input.recoverySubgraphStepIds ? { recoverySubgraphStepIds: input.recoverySubgraphStepIds } : {}),
    ...(input.lockResumeMode ? { lockResumeMode: input.lockResumeMode } : {}),
    ...(input.planningWindowState ? { planningWindowState: input.planningWindowState } : {}),
    ...(input.recoveryStepId ? { recoveryStepId: input.recoveryStepId } : {}),
    ...(input.recoveryReason ? { recoveryReason: input.recoveryReason } : {}),
    ...(input.blockedReasons && input.blockedReasons.length > 0 ? { blockedReasons: input.blockedReasons } : {}),
    ...(input.latestConflict ? { latestConflict: input.latestConflict } : {}),
  });
  await writePlannerExecutionArtifacts(session, graph, lockTable, next);
  return next;
}
