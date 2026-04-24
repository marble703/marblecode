import { derivePlannerAccessMode, derivePlannerFileScope, type PlannerExecutionGraph } from './graph.js';
import type { PlannerPlan, PlannerStep } from './types.js';

export function selectExecutionWave(
  readySteps: PlannerStep[],
  graph: PlannerExecutionGraph,
  maxConcurrentSubtasks: number,
  classifyStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify',
): PlannerStep[] {
  const readyById = new Map(readySteps.map((step) => [step.id, step]));
  for (const wave of graph.waves) {
    const candidates = wave.stepIds
      .map((stepId) => readyById.get(stepId))
      .filter((step): step is PlannerStep => Boolean(step));
    if (candidates.length === 0) {
      continue;
    }
    const verify = candidates.find((step) => classifyStep(step) === 'verify');
    if (verify) {
      return [verify];
    }
    if (maxConcurrentSubtasks <= 1) {
      return [candidates[0]].filter((step): step is PlannerStep => Boolean(step));
    }
    const restricted = candidates.filter((step) => derivePlannerAccessMode(step) === 'write' && derivePlannerFileScope(step).length === 0);
    if (restricted.length > 0) {
      return [restricted[0]].filter((step): step is PlannerStep => Boolean(step));
    }
    return candidates.slice(0, maxConcurrentSubtasks);
  }

  return readySteps.length > 0 ? [readySteps[0]].filter((step): step is PlannerStep => Boolean(step)) : [];
}

export function detectPendingConflictFailure(plan: PlannerPlan, graph: PlannerExecutionGraph): string | null {
  const pending = new Set(plan.steps.filter((step) => step.status !== 'DONE' && step.status !== 'FAILED').map((step) => step.id));
  const edge = graph.edges.find((candidate) => candidate.type === 'conflict' && pending.has(candidate.from) && pending.has(candidate.to));
  if (!edge) {
    return null;
  }

  return `Planner execution conflict detected between ${edge.from} and ${edge.to}.`;
}

export function mergePlannerStepResult(
  basePlan: PlannerPlan,
  updatedPlan: PlannerPlan,
  stepId: string,
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
): PlannerPlan {
  const updatedStep = updatedPlan.steps.find((step) => step.id === stepId);
  if (!updatedStep) {
    return basePlan;
  }
  return updatePlannerStep(basePlan, stepId, updatedStep);
}

export function annotateBlockedDependents(
  plan: PlannerPlan,
  failedStepIds: Set<string>,
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
): PlannerPlan {
  let nextPlan = plan;
  for (const step of plan.steps) {
    if (step.status === 'DONE' || step.status === 'FAILED') {
      continue;
    }

    const blockingDependencies = step.dependencies.filter((dependency) => failedStepIds.has(dependency));
    if (blockingDependencies.length === 0) {
      continue;
    }

    const message = `Blocked by failed dependencies: ${blockingDependencies.join(', ')}`;
    nextPlan = updatePlannerStep(nextPlan, step.id, {
      executionState: 'blocked',
      failureKind: 'dependency',
      lastError: message,
      details: message,
    });
  }

  return nextPlan;
}
