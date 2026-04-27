import { runPlanConsistencyChecks } from './parse.js';
import type { PlannerPlan, PlannerStep } from './types.js';
import { mergeStringLists } from './utils.js';

export interface PlannerReplanProposal {
  version: '1';
  failedStepId: string;
  failureMessage: string;
  previousRevision: number;
  proposedRevision: number;
  proposedPlan: PlannerPlan;
  createdAt: string;
}

export interface PlannerReplanValidationResult {
  ok: boolean;
  errors: string[];
}

export interface PlannerReplanMergeResult {
  plan: PlannerPlan;
  validation: PlannerReplanValidationResult;
}

const COMPLETED_STEP_LOCKED_FIELDS = [
  'id',
  'title',
  'kind',
  'dependencies',
  'fileScope',
  'accessMode',
  'mustRunAfter',
  'fallbackStepIds',
  'conflictsWith',
] as const;

type CompletedStepLockedField = typeof COMPLETED_STEP_LOCKED_FIELDS[number];

export function buildReplanProposal(input: {
  failedStepId: string;
  failureMessage: string;
  previousPlan: PlannerPlan;
  proposedPlan: PlannerPlan;
  createdAt?: string;
}): PlannerReplanProposal {
  return {
    version: '1',
    failedStepId: input.failedStepId,
    failureMessage: input.failureMessage,
    previousRevision: input.previousPlan.revision,
    proposedRevision: input.proposedPlan.revision,
    proposedPlan: input.proposedPlan,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function validateReplanProposal(
  previousPlan: PlannerPlan,
  proposedPlan: PlannerPlan,
  failedStepId: string,
): PlannerReplanValidationResult {
  const errors = runPlanConsistencyChecks(proposedPlan);
  const previousSteps = new Map(previousPlan.steps.map((step) => [step.id, step]));
  const proposedSteps = new Map(proposedPlan.steps.map((step) => [step.id, step]));
  const failedStep = proposedSteps.get(failedStepId);

  if (!failedStep) {
    errors.push(`Replanned plan removed failed step ${failedStepId}`);
  } else if (failedStep.status === 'DONE') {
    errors.push(`Replanned failed step ${failedStepId} cannot be DONE`);
  }

  for (const previous of previousPlan.steps) {
    if (previous.status !== 'DONE') {
      continue;
    }
    const proposed = proposedSteps.get(previous.id);
    if (!proposed) {
      errors.push(`Replanned plan removed completed step ${previous.id}`);
      continue;
    }
    if (proposed.status !== 'DONE') {
      errors.push(`Replanned plan changed completed step ${previous.id} status from DONE to ${proposed.status}`);
    }
    for (const field of COMPLETED_STEP_LOCKED_FIELDS) {
      if (!sameLockedField(previous, proposed, field)) {
        errors.push(`Replanned plan changed completed step ${previous.id} ${field}`);
      }
    }
  }

  for (const proposed of proposedPlan.steps) {
    const previous = previousSteps.get(proposed.id);
    if (previous?.status === 'DONE' && proposed.status !== 'DONE') {
      errors.push(`Replanned plan cannot reactivate completed step ${proposed.id}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function mergeReplanProposal(
  previousPlan: PlannerPlan,
  proposedPlan: PlannerPlan,
  failedStepId: string,
  failureMessage: string,
): PlannerReplanMergeResult {
  const validation = validateReplanProposal(previousPlan, proposedPlan, failedStepId);
  if (!validation.ok) {
    return { plan: previousPlan, validation };
  }

  const previousSteps = new Map(previousPlan.steps.map((step) => [step.id, step]));
  const plan: PlannerPlan = {
    ...proposedPlan,
    steps: proposedPlan.steps.map((step) => {
      const previous = previousSteps.get(step.id);
      if (previous?.status === 'DONE') {
        const completedStep: PlannerStep = {
          ...step,
          status: 'DONE',
          attempts: previous.attempts,
          executionState: 'done',
          relatedFiles: mergeStringLists(step.relatedFiles ?? [], previous.relatedFiles ?? []),
          producesFiles: mergeStringLists(step.producesFiles ?? [], previous.producesFiles ?? []),
        };
        if (previous.lastError) {
          completedStep.lastError = previous.lastError;
        }
        return completedStep;
      }
      if (step.id === failedStepId) {
        return {
          ...step,
          attempts: 0,
          executionState: 'idle',
          lastError: failureMessage,
          failureKind: 'replan_required',
          status: 'PENDING',
        };
      }
      return step;
    }),
  };

  return { plan, validation };
}

function sameLockedField(left: PlannerStep, right: PlannerStep, field: CompletedStepLockedField): boolean {
  return JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null);
}
