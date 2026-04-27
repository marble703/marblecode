import { buildExecutionGraph as buildPlannerExecutionGraph, getBlockedReasons, type PlannerExecutionGraph } from './graph.js';
import type { PlannerFailureTolerance, PlannerPhase, PlannerPlan, PlannerState, PlannerStep, PlannerStepExecutionState, PlannerStepStatus } from './types.js';

export function statusToPhase(status: PlannerStepStatus): PlannerPhase {
  if (status === 'PENDING') {
    return 'PLANNING';
  }
  if (status === 'SEARCHING') {
    return 'SEARCHING';
  }
  if (status === 'PATCHING') {
    return 'PATCHING';
  }
  if (status === 'VERIFYING') {
    return 'VERIFYING';
  }
  return 'PENDING';
}

export function refreshPlannerStateFromPlan(plan: PlannerPlan | undefined, state: PlannerState): PlannerState {
  if (!plan) {
    return {
      ...state,
      activeStepIds: [],
      readyStepIds: [],
      completedStepIds: [],
      failedStepIds: [],
      blockedStepIds: [],
      degradedStepIds: [],
    };
  }

  const graph = buildPlannerExecutionGraph(plan);
  const activeStepIds: string[] = [];
  const readyStepIds: string[] = [];
  const completedStepIds: string[] = [];
  const failedStepIds: string[] = [];
  const blockedStepIds: string[] = [];
  const degradedStepIds: string[] = [];

  for (const step of plan.steps) {
    if (step.status === 'FAILED' && step.failureTolerance === 'degrade') {
      degradedStepIds.push(step.id);
      continue;
    }
    const executionState = deriveExecutionState(step, plan, graph);
    if (executionState === 'running' || executionState === 'retrying' || executionState === 'fallback') {
      activeStepIds.push(step.id);
      continue;
    }
    if (executionState === 'done') {
      completedStepIds.push(step.id);
      continue;
    }
    if (executionState === 'failed') {
      failedStepIds.push(step.id);
      continue;
    }
    if (executionState === 'blocked') {
      blockedStepIds.push(step.id);
      continue;
    }
    if (executionState === 'ready') {
      readyStepIds.push(step.id);
    }
  }

  return {
    ...state,
    activeStepIds,
    readyStepIds,
    completedStepIds,
    failedStepIds,
    blockedStepIds,
    degradedStepIds,
    currentStepId: activeStepIds[0] ?? readyStepIds[0] ?? null,
  };
}

function deriveExecutionState(step: PlannerStep, plan: PlannerPlan, graph: PlannerExecutionGraph): PlannerStepExecutionState {
  if (step.executionState === 'running' || step.executionState === 'retrying' || step.executionState === 'fallback') {
    return step.executionState;
  }
  if (step.status === 'DONE') {
    return 'done';
  }
  if (step.status === 'FAILED') {
    return 'failed';
  }
  if (getBlockedReasons(step, plan, graph).length > 0) {
    return 'blocked';
  }
  return 'ready';
}

export function isPlannerStepDegraded(step: PlannerStep): boolean {
  return step.status === 'FAILED' && effectiveFailureTolerance(step.failureTolerance) === 'degrade';
}

function effectiveFailureTolerance(value: PlannerFailureTolerance | undefined): PlannerFailureTolerance {
  return value ?? 'none';
}
