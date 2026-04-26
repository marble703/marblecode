import type { PlannerExecutionGraph } from './graph.js';
import { detectPendingConflictFailure, selectExecutionWave } from './execute-wave.js';
import type { PlannerExecutionStrategy, PlannerExecutionStrategyMode } from './execution-types.js';
import type { PlannerPlan, PlannerStep } from './types.js';

function createWaveSelectingStrategy(
  mode: PlannerExecutionStrategyMode,
  checkConflicts: (plan: PlannerPlan, graph: PlannerExecutionGraph) => string | null,
  selectWave: PlannerExecutionStrategy['selectWave'],
): PlannerExecutionStrategy {
  return {
    mode,
    checkConflicts,
    selectWave,
  };
}

export function getPlannerExecutionStrategy(mode: PlannerExecutionStrategyMode): PlannerExecutionStrategy {
  if (mode === 'fail') {
    return createWaveSelectingStrategy('fail', detectPendingConflictFailure, selectExecutionWave);
  }

  if (mode === 'deterministic') {
    return createWaveSelectingStrategy(
      'deterministic',
      () => null,
      (readySteps) => (readySteps.length > 0 ? [readySteps[0]].filter((step): step is PlannerStep => Boolean(step)) : []),
    );
  }

  if (mode === 'aggressive') {
    return createWaveSelectingStrategy(
      'aggressive',
      () => null,
      (readySteps, graph, maxConcurrentSubtasks, classifyStep) => {
        const selected = selectExecutionWave(readySteps, graph, Math.max(maxConcurrentSubtasks, readySteps.length), classifyStep);
        return selected;
      },
    );
  }

  return createWaveSelectingStrategy('serial', () => null, selectExecutionWave);
}
