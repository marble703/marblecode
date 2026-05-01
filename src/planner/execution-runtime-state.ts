import { plannerHasUnsatisfiedDependencies } from './dependencies.js';
import { derivePlannerAccessMode, derivePlannerConflictDomains, derivePlannerFileScope } from './step-metadata.js';
import type { PlannerRuntimeState, PlannerRuntimeTask, PlannerRuntimeTaskStatus } from './execution-runtime-types.js';
import type { PlannerFailureTolerance, PlannerPlan } from './types.js';

export function createPlannerRuntimeState(plan: PlannerPlan): PlannerRuntimeState {
  return {
    version: '1',
    revision: plan.revision,
    phase: 'idle',
    tasks: plan.steps.map((step) => ({
      id: step.id,
      stepId: step.id,
      title: step.title,
      kind: step.kind,
      status: deriveRuntimeTaskStatus(step.status, step.failureTolerance),
      dependsOn: [...step.dependencies],
      fileScope: derivePlannerFileScope(step),
      accessMode: derivePlannerAccessMode(step),
      conflictDomains: derivePlannerConflictDomains(step),
      attempts: step.attempts,
      maxAttempts: step.maxAttempts ?? 1,
      failureTolerance: step.failureTolerance ?? 'none',
      ...(step.dependencyTolerances ? { dependencyTolerances: step.dependencyTolerances } : {}),
      changedFiles: [...new Set([...(step.relatedFiles ?? []), ...(step.producesFiles ?? [])])],
      ...(step.lastError ? { lastError: step.lastError } : {}),
    })),
    locks: [],
    epoch: 0,
    message: plan.summary,
  };
}

export function deriveReadyRuntimeTaskIds(state: PlannerRuntimeState): string[] {
  const plan = buildPlanViewFromRuntime(state);
  return state.tasks
    .filter((task) => task.status === 'pending')
    .filter((task) => !plannerHasUnsatisfiedDependencies(plan.stepsById.get(task.stepId) ?? buildSyntheticMissingStep(task.stepId), plan.plan))
    .map((task) => task.id);
}

function deriveRuntimeTaskStatus(status: 'PENDING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'FAILED' | 'DONE', failureTolerance: PlannerFailureTolerance | undefined): PlannerRuntimeTaskStatus {
  if (status === 'DONE') {
    return 'done';
  }
  if (status === 'FAILED') {
    return failureTolerance === 'degrade' ? 'degraded' : 'failed';
  }
  return 'pending';
}

function buildPlanViewFromRuntime(state: PlannerRuntimeState): {
  plan: PlannerPlan;
  stepsById: Map<string, PlannerPlan['steps'][number]>;
} {
  const steps = state.tasks.map((task) => ({
    id: task.stepId,
    title: task.title,
    status: runtimeStatusToPlannerStatus(task.status),
    kind: task.kind,
    attempts: task.attempts,
    dependencies: task.dependsOn,
    ...(task.dependencyTolerances ? { dependencyTolerances: task.dependencyTolerances } : {}),
    children: [],
    ...(task.fileScope.length > 0 ? { fileScope: task.fileScope } : {}),
    accessMode: task.accessMode,
    failureTolerance: task.failureTolerance,
    ...(task.changedFiles.length > 0 ? { relatedFiles: task.changedFiles } : {}),
    ...(task.lastError ? { lastError: task.lastError } : {}),
  }));
  const plan: PlannerPlan = {
    version: '1',
    revision: state.revision,
    summary: state.message,
    steps,
  };
  return {
    plan,
    stepsById: new Map(steps.map((step) => [step.id, step])),
  };
}

function buildSyntheticMissingStep(stepId: string): PlannerPlan['steps'][number] {
  return {
    id: stepId,
    title: stepId,
    status: 'FAILED',
    kind: 'note',
    attempts: 0,
    dependencies: [],
    children: [],
  };
}

function runtimeStatusToPlannerStatus(status: PlannerRuntimeTaskStatus): 'PENDING' | 'FAILED' | 'DONE' | 'PATCHING' {
  if (status === 'done') {
    return 'DONE';
  }
  if (status === 'failed' || status === 'degraded') {
    return 'FAILED';
  }
  if (status === 'running') {
    return 'PATCHING';
  }
  return 'PENDING';
}
