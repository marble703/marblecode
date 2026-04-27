import { buildExecutionGraph, hasDependencyCycle, type PlannerExecutionEdge } from './graph.js';
import type { ExecutionLockTable } from './locks.js';
import { canTransferOwnership } from './ownership.js';
import { runPlanConsistencyChecks } from './parse.js';
import type { PlannerPlan, PlannerPlanDeltaArtifact, PlannerStep } from './types.js';
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

export interface PlannerPlanAppendValidationResult {
  ok: boolean;
  errors: string[];
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

const SCOPE_LOCKED_FIELDS = [
  'title',
  'kind',
  'details',
  'relatedFiles',
  'dependencies',
  'fileScope',
  'accessMode',
  'mustRunAfter',
  'fallbackStepIds',
  'conflictsWith',
] as const;

type CompletedStepLockedField = typeof COMPLETED_STEP_LOCKED_FIELDS[number];
type ScopeLockedField = typeof SCOPE_LOCKED_FIELDS[number];

export interface PlannerReplanScope {
  allowedStepIds: Set<string>;
  protectedStepIds: Set<string>;
}

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
  const scope = collectReplanScope(previousPlan, failedStepId);

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

  for (const previous of previousPlan.steps) {
    if (!scope.protectedStepIds.has(previous.id)) {
      continue;
    }
    const proposed = proposedSteps.get(previous.id);
    if (!proposed) {
      errors.push(`Replanned plan removed protected step ${previous.id}`);
      continue;
    }
    for (const field of SCOPE_LOCKED_FIELDS) {
      if (!sameScopeField(previous, proposed, field)) {
        errors.push(`Replanned plan changed protected step ${previous.id} ${field} outside replan scope`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function collectReplanScope(previousPlan: PlannerPlan, failedStepId: string): PlannerReplanScope {
  const graph = buildExecutionGraph(previousPlan);
  const adjacency = new Map<string, string[]>();
  for (const step of previousPlan.steps) {
    adjacency.set(step.id, []);
  }
  for (const edge of graph.edges) {
    if (!isScopedEdge(edge)) {
      continue;
    }
    const next = adjacency.get(edge.from);
    if (next) {
      next.push(edge.to);
    }
  }

  const allowedStepIds = new Set<string>();
  const queue = [failedStepId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || allowedStepIds.has(current)) {
      continue;
    }
    const currentStep = previousPlan.steps.find((step) => step.id === current);
    if (!currentStep) {
      continue;
    }
    if (currentStep.status !== 'DONE') {
      allowedStepIds.add(current);
    }
    for (const next of adjacency.get(current) ?? []) {
      if (!allowedStepIds.has(next)) {
        queue.push(next);
      }
    }
  }

  const protectedStepIds = new Set(
    previousPlan.steps
      .filter((step) => step.status !== 'DONE' && !allowedStepIds.has(step.id))
      .map((step) => step.id),
  );

  return { allowedStepIds, protectedStepIds };
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

export function validatePlanAppend(
  previousPlan: PlannerPlan,
  appendPlan: PlannerPlan,
  lockTable?: ExecutionLockTable,
): PlannerPlanAppendValidationResult {
  const errors: string[] = [];
  const previousSteps = new Map(previousPlan.steps.map((step) => [step.id, step]));

  for (const previous of previousPlan.steps) {
    if (appendPlan.steps.some((step) => step.id === previous.id)) {
      errors.push(`Plan append cannot redefine existing step ${previous.id}`);
    }
  }

  const mergedPlan = mergePlanAppend(previousPlan, appendPlan);
  errors.push(...runPlanConsistencyChecks(mergedPlan));
  const mergedGraph = buildExecutionGraph(mergedPlan);
  if (hasDependencyCycle(mergedGraph)) {
    errors.push('Plan append introduces a dependency cycle.');
  }

  for (const step of appendPlan.steps) {
    if (step.accessMode !== 'write') {
      continue;
    }
    for (const filePath of step.fileScope ?? []) {
      if (!lockTable) {
        continue;
      }
      const entry = lockTable.entries.find((candidate) => candidate.path === filePath);
      if (!entry) {
        continue;
      }
      const owner = previousSteps.get(entry.ownerStepId);
      if (owner?.status === 'DONE' && canTransferOwnership(mergedPlan, entry.ownerStepId, step.id)) {
        continue;
      }
      errors.push(`Plan append step ${step.id} conflicts with active lock on ${filePath} owned by ${entry.ownerStepId}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function mergePlanAppend(previousPlan: PlannerPlan, appendPlan: PlannerPlan): PlannerPlan {
  return {
    ...previousPlan,
    revision: appendPlan.revision,
    summary: appendPlan.summary || previousPlan.summary,
    steps: [...previousPlan.steps, ...appendPlan.steps],
    ...(appendPlan.isPartial === true ? { isPartial: true } : {}),
    ...(appendPlan.isPartial === false || appendPlan.isPartial === undefined ? { isPartial: false } : {}),
    ...(appendPlan.planningHorizon ? { planningHorizon: appendPlan.planningHorizon } : {}),
    ...(appendPlan.openQuestions ? { openQuestions: appendPlan.openQuestions } : {}),
    ...(appendPlan.nextPlanningTriggers ? { nextPlanningTriggers: appendPlan.nextPlanningTriggers } : {}),
  };
}

export function buildPlanAppendDeltaArtifact(input: {
  previousPlan: PlannerPlan;
  appendPlan: PlannerPlan;
  mergedPlan: PlannerPlan;
  planningWindowWaves: number;
  reason: string;
}): PlannerPlanDeltaArtifact {
  return {
    version: '1',
    baseRevision: input.previousPlan.revision,
    nextRevision: input.mergedPlan.revision,
    reason: input.reason,
    planningWindowWaves: input.planningWindowWaves,
    addedStepIds: input.appendPlan.steps.map((step) => step.id),
    addedSteps: input.appendPlan.steps,
    summary: input.mergedPlan.summary,
    combinedIsPartial: input.mergedPlan.isPartial === true,
  };
}

export function computeUndeclaredChangedFiles(
  step: PlannerStep,
  declaredWritePaths: string[],
  actualChangedFiles: string[],
): string[] {
  const declared = new Set(declaredWritePaths);
  return actualChangedFiles.filter((file) => !declared.has(file));
}

export function buildPlannerAffectedSubgraph(
  plan: PlannerPlan,
  triggerStepId: string,
  undeclaredFiles: string[],
): Set<string> {
  const graph = buildExecutionGraph(plan);
  const affected = new Set<string>();
  const queue = [triggerStepId];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || affected.has(current)) {
      continue;
    }
    const step = plan.steps.find((candidate) => candidate.id === current);
    if (!step || step.status === 'DONE') {
      continue;
    }
    affected.add(current);

    for (const edge of graph.edges) {
      const isScoped = edge.type === 'dependency' || edge.type === 'must_run_after' || edge.type === 'fallback';
      if (!isScoped) {
        continue;
      }
      if (edge.from === current && !affected.has(edge.to)) {
        queue.push(edge.to);
      }
    }
  }

  for (const step of plan.steps) {
    if (step.status === 'DONE') {
      continue;
    }
    if (affected.has(step.id)) {
      continue;
    }
    if (step.conflictDomains && step.conflictDomains.length > 0) {
      for (const affectedId of affected) {
        const affectedStep = plan.steps.find((candidate) => candidate.id === affectedId);
        if (affectedStep?.conflictDomains?.some((domain) => step.conflictDomains?.includes(domain))) {
          affected.add(step.id);
          queue.push(step.id);
          break;
        }
      }
    }
    if (undeclaredFiles.length > 0 && (step.fileScope ?? []).some((file) => undeclaredFiles.includes(file))) {
      affected.add(step.id);
      queue.push(step.id);
    }
  }

  return affected;
}

export function validateAppendActiveWaveConflict(
  previousPlan: PlannerPlan,
  appendPlan: PlannerPlan,
  activeWaveStepIds: string[],
  lockTable: ExecutionLockTable,
): string[] {
  const errors: string[] = [];
  const mergedPlan = mergePlanAppend(previousPlan, appendPlan);

  for (const step of appendPlan.steps) {
    if (step.accessMode !== 'write') {
      continue;
    }
    for (const filePath of step.fileScope ?? []) {
      const entry = lockTable.entries.find((candidate) => candidate.path === filePath);
      if (!entry) {
        continue;
      }
      const previousSteps = new Map(previousPlan.steps.map((s) => [s.id, s]));
      const owner = previousSteps.get(entry.ownerStepId);
      if (owner?.status === 'DONE' && canTransferOwnership(mergedPlan, entry.ownerStepId, step.id)) {
        continue;
      }
      errors.push(`Plan append step ${step.id} conflicts with active lock on ${filePath} owned by ${entry.ownerStepId}`);
    }
  }

  const mergedGraph = buildExecutionGraph(mergedPlan);
  for (const step of appendPlan.steps) {
    if (step.accessMode !== 'write') {
      continue;
    }
    for (const activeStepId of activeWaveStepIds) {
      const activeStep = previousPlan.steps.find((s) => s.id === activeStepId);
      if (!activeStep || activeStep.status === 'DONE' || activeStep.status === 'FAILED') {
        continue;
      }
      const activeNode = mergedGraph.nodes.find((n) => n.stepId === activeStepId);
      const appendNode = mergedGraph.nodes.find((n) => n.stepId === step.id);
      if (!activeNode || !appendNode) {
        continue;
      }
      if (activeNode.conflictDomains.some((d) => appendNode.conflictDomains.includes(d))) {
        errors.push(`Plan append step ${step.id} conflict domain collides with active step ${activeStepId}`);
      }
      const scopeOverlap = (step.fileScope ?? []).some((f) => (activeStep.fileScope ?? []).includes(f));
      if (scopeOverlap) {
        errors.push(`Plan append step ${step.id} file scope collides with active step ${activeStepId}`);
      }
    }
  }

  return errors;
}

export function validateReplanLockCompatibility(
  previousPlan: PlannerPlan,
  proposedPlan: PlannerPlan,
  failedStepId: string,
  lockTable: ExecutionLockTable,
): string[] {
  const scope = collectReplanScope(previousPlan, failedStepId);
  const errors: string[] = [];

  for (const stepId of scope.allowedStepIds) {
    const step = proposedPlan.steps.find((candidate) => candidate.id === stepId);
    if (!step || step.accessMode !== 'write') {
      continue;
    }
    for (const filePath of step.fileScope ?? []) {
      const entry = lockTable.entries.find((candidate) => candidate.path === filePath);
      if (!entry) {
        continue;
      }
      if (entry.ownerStepId === step.id || entry.ownerStepId === failedStepId) {
        continue;
      }
      if (canTransferOwnership(proposedPlan, entry.ownerStepId, step.id) || canTransferOwnership(previousPlan, entry.ownerStepId, step.id)) {
        continue;
      }
      errors.push(`Replanned step ${step.id} cannot write locked path ${filePath}; current owner is ${entry.ownerStepId}`);
    }
  }

  return errors;
}

function sameLockedField(left: PlannerStep, right: PlannerStep, field: CompletedStepLockedField): boolean {
  return JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null);
}

function sameScopeField(left: PlannerStep, right: PlannerStep, field: ScopeLockedField): boolean {
  return JSON.stringify(left[field] ?? null) === JSON.stringify(right[field] ?? null);
}

function isScopedEdge(edge: PlannerExecutionEdge): boolean {
  return edge.type === 'dependency' || edge.type === 'must_run_after' || edge.type === 'fallback';
}
