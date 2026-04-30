import type { PlannerBlockedReason, PlannerConflictSummary, PlannerExecutionGraph } from './graph.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerPlan, PlannerState, PlannerStep } from './types.js';

export type PlannerExecutionPhase = 'idle' | 'planning' | 'locking' | 'executing_wave' | 'converging' | 'recovering' | 'done' | 'failed';

export type PlannerExecutionStrategyMode = 'serial' | 'fail' | 'aggressive' | 'deterministic';

export interface PlannerExecutionStateArtifact {
  version: '1';
  revision: number;
  executionPhase: PlannerExecutionPhase;
  plannerPhase: PlannerState['phase'];
  outcome: PlannerState['outcome'];
  activeStepIds: string[];
  readyStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  blockedStepIds: string[];
  degradedStepIds: string[];
  blockedReasons?: PlannerBlockedReason[];
  latestConflict?: PlannerConflictSummary;
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  strategy: PlannerExecutionStrategyMode;
  epoch: number;
  currentStepId: string | null;
  message: string;
  selectedWaveStepIds?: string[];
  resumeStrategy?: 'continue_wave' | 'rerun_active' | 'rerun_ready' | 'rebuild_from_plan' | 'resume_recovering' | 'resume_fallback_path' | 'return_terminal';
  interruptedStepIds?: string[];
  lastEventType?: PlannerExecutionEventType;
  lastEventReason?: string;
  activeLockOwnerStepIds?: string[];
  preservedLockOwnerStepIds?: string[];
  reusedLockOwnerStepIds?: string[];
  downgradedLockOwnerStepIds?: string[];
  droppedLockOwnerStepIds?: string[];
  recoverySourceStepId?: string;
  recoverySubgraphStepIds?: string[];
  lockResumeMode?: 'reacquire' | 'preserve_guarded' | 'drop_unrelated_writes';
  planningWindowState?: 'executing' | 'completed_waiting_append';
  recoveryStepId?: string;
  recoveryReason?: string;
}

export type PlannerExecutionEventType =
  | 'EXECUTION_INITIALIZED'
  | 'CONFLICT_DETECTED'
  | 'DEPENDENCIES_BLOCKED'
  | 'SKIP_WAVE_COMPLETED'
  | 'VERIFY_STEP_STARTED'
  | 'VERIFY_STEP_SUCCEEDED'
  | 'VERIFY_STEP_FAILED'
  | 'LOCKS_ACQUIRED'
  | 'WAVE_EXECUTED'
  | 'WAVE_REPLANNED'
  | 'FALLBACK_ACTIVATED'
  | 'WAVE_FAILED'
  | 'WAVE_CONVERGED'
  | 'EXECUTION_COMPLETED';

export interface PlannerExecutionArtifacts {
  plan: PlannerPlan;
  state: PlannerState;
  graph: PlannerExecutionGraph;
  lockTable: ExecutionLockTable;
  executionState: PlannerExecutionStateArtifact;
}

export interface PlannerExecutionStrategy {
  mode: PlannerExecutionStrategyMode;
  checkConflicts(plan: PlannerPlan, graph: PlannerExecutionGraph): string | null;
  selectWave(
    readySteps: PlannerStep[],
    graph: PlannerExecutionGraph,
    maxConcurrentSubtasks: number,
    classifyStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify',
  ): PlannerStep[];
}
