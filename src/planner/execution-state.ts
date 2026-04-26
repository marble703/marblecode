import type { PlannerExecutionStateArtifact, PlannerExecutionStrategyMode } from './execution-types.js';
import type { PlannerState } from './types.js';

export function createPlannerExecutionState(
  state: PlannerState,
  strategy: PlannerExecutionStrategyMode,
  executionPhase: PlannerExecutionStateArtifact['executionPhase'],
  extras?: {
    currentWaveStepIds?: string[];
    lastCompletedWaveStepIds?: string[];
    epoch?: number;
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
    currentWaveStepIds: extras?.currentWaveStepIds ?? [],
    lastCompletedWaveStepIds: extras?.lastCompletedWaveStepIds ?? [],
    strategy,
    epoch: extras?.epoch ?? 0,
    currentStepId: state.currentStepId,
    message: state.message,
    ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
    ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
  };
}
