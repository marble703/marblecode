import type { PlannerPlan } from './types.js';

export function canTransferOwnership(plan: PlannerPlan, fromStepId: string, toStepId: string): boolean {
  const target = plan.steps.find((step) => step.id === toStepId);
  if (!target) {
    return false;
  }
  return target.dependencies.includes(fromStepId)
    || (target.mustRunAfter ?? []).includes(fromStepId)
    || plan.steps.find((step) => step.id === fromStepId)?.ownershipTransfers?.includes(toStepId)
    || fromStepId === toStepId;
}
