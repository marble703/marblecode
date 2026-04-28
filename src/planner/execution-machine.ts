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
  recoverySourceStepId?: string;
  recoverySubgraphStepIds?: string[];
  lockResumeMode?: PlannerExecutionStateArtifact['lockResumeMode'];
  recoveryStepId?: string;
  recoveryReason?: string;
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
  extras?: Omit<PlannerExecutionSnapshotInput, 'state' | 'strategy'>,
): PlannerExecutionStateArtifact {
  return createPlannerExecutionState(state, strategy, 'idle', extras);
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
    ...(input.recoverySourceStepId ? { recoverySourceStepId: input.recoverySourceStepId } : {}),
    ...(input.recoverySubgraphStepIds ? { recoverySubgraphStepIds: input.recoverySubgraphStepIds } : {}),
    ...(input.lockResumeMode ? { lockResumeMode: input.lockResumeMode } : {}),
    ...(input.recoveryStepId ? { recoveryStepId: input.recoveryStepId } : {}),
    ...(input.recoveryReason ? { recoveryReason: input.recoveryReason } : {}),
  });
  await writePlannerExecutionArtifacts(session, graph, lockTable, next);
  return next;
}
