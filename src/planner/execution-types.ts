import type { PlannerExecutionGraph } from './graph.js';
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
  currentWaveStepIds: string[];
  lastCompletedWaveStepIds: string[];
  strategy: PlannerExecutionStrategyMode;
  epoch: number;
  currentStepId: string | null;
  message: string;
  recoveryStepId?: string;
  recoveryReason?: string;
}

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
