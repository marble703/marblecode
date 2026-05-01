import type { PlannerPlan, PlannerStep } from './types.js';

export function plannerDependencySatisfied(step: PlannerStep, dependencyId: string, plan: PlannerPlan): boolean {
  const dependency = plan.steps.find((candidate) => candidate.id === dependencyId);
  if (!dependency) {
    return false;
  }
  if (dependency.status === 'DONE') {
    return true;
  }
  if (step.kind === 'verify') {
    return false;
  }

  const tolerance = step.dependencyTolerances?.[dependencyId] ?? 'required';
  return tolerance === 'degrade' && dependency.status === 'FAILED' && dependency.failureTolerance === 'degrade';
}

export function plannerHasUnsatisfiedDependencies(step: PlannerStep, plan: PlannerPlan): boolean {
  for (const dependencyId of step.dependencies) {
    if (!plannerDependencySatisfied(step, dependencyId, plan)) {
      return true;
    }
  }

  return false;
}
