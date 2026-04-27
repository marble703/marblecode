import { extractJsonObject } from '../shared/json-response.js';
import { buildExecutionGraph as buildPlannerExecutionGraph, hasDependencyCycle } from './graph.js';
import type {
  PlannerContextPacket,
  PlannerFailureKind,
  PlannerFailureTolerance,
  PlannerPlan,
  PlannerPlanPayload,
  PlannerResponse,
  PlannerStep,
  PlannerStepExecutionState,
  PlannerStepStatus,
} from './types.js';
import { normalizePlannerFilePath } from './utils.js';

export function parsePlannerResponse(content: string): PlannerResponse {
  const parsed = JSON.parse(extractJsonObject(content)) as Record<string, unknown>;
  const type = parsed.type;

  if (type === 'patch') {
    throw new Error('Planner mode is read-only. Response type patch is forbidden.');
  }

  if (type === 'tool_call') {
    return withOptionalThought(
      {
        type: 'tool_call',
        tool: String(parsed.tool),
        input: (parsed.input as Record<string, unknown>) ?? {},
      },
      parsed.thought,
    );
  }

  if (type === 'plan') {
    const rawPlan = parsed.plan;
    if (!rawPlan || typeof rawPlan !== 'object') {
      throw new Error('Planner response did not contain a valid plan object.');
    }
    return withOptionalThought(
      {
        type: 'plan',
        plan: rawPlan as PlannerPlanPayload,
      },
      parsed.thought,
    );
  }

  if (type === 'plan_update') {
    return withOptionalThought(
      {
        type: 'plan_update',
        stepId: String(parsed.stepId ?? ''),
        status: normalizeStepStatus(parsed.status),
        ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
        ...(Array.isArray(parsed.relatedFiles) ? { relatedFiles: parsed.relatedFiles.filter((item): item is string => typeof item === 'string') } : {}),
      },
      parsed.thought,
    );
  }

  if (type === 'final') {
    const outcome = parsed.outcome;
    const normalizedOutcome = outcome === 'FAILED' || outcome === 'DONE' || outcome === 'CANCELLED' || outcome === 'NEEDS_INPUT'
      ? outcome
      : 'DONE';
    return withOptionalThought(
      {
        type: 'final',
        message: String(parsed.message ?? ''),
        outcome: normalizedOutcome,
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
      },
      parsed.thought,
    );
  }

  throw new Error('Planner response did not contain a valid planner step.');
}

export function normalizePlannerPlan(input: PlannerPlanPayload, revision: number, workspaceRoot: string): PlannerPlan {
  const stepsInput = Array.isArray(input.steps) ? input.steps : [];
  const steps = stepsInput.map((step: unknown, index: number) => normalizePlannerStep(step, index, workspaceRoot));
  const plan: PlannerPlan = {
    version: '1',
    revision: typeof input.revision === 'number' ? input.revision : revision,
    summary: String(input.summary ?? ''),
    steps,
  };
  const errors = runPlanConsistencyChecks(plan);
  if (errors.length > 0) {
    throw new Error(`Planner plan is invalid: ${errors.join('; ')}`);
  }
  return plan;
}

export function applyPlanUpdate(plan: PlannerPlan, update: Extract<PlannerResponse, { type: 'plan_update' }>): PlannerPlan {
  const stepIndex = plan.steps.findIndex((step) => step.id === update.stepId);
  if (stepIndex < 0) {
    throw new Error(`Planner update referenced unknown step: ${update.stepId}`);
  }

  const current = plan.steps[stepIndex];
  if (!current) {
    throw new Error(`Planner update referenced unknown step: ${update.stepId}`);
  }

  const next: PlannerStep = {
    ...current,
    status: update.status,
    ...(update.message ? { details: update.message } : {}),
    ...(update.relatedFiles ? { relatedFiles: update.relatedFiles } : {}),
  };
  const steps = plan.steps.slice();
  steps[stepIndex] = next;
  return {
    ...plan,
    steps,
  };
}

export function runPlanConsistencyChecks(plan: PlannerPlan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id) {
      errors.push('Plan step is missing an id.');
      continue;
    }
    if (ids.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        errors.push(`Unknown dependency ${dependency} referenced by ${step.id}`);
      }
    }
    for (const fallback of step.fallbackStepIds ?? []) {
      if (!ids.has(fallback)) {
        errors.push(`Unknown fallback step ${fallback} referenced by ${step.id}`);
      }
    }
    for (const conflict of step.conflictsWith ?? []) {
      if (!ids.has(conflict)) {
        errors.push(`Unknown conflict step ${conflict} referenced by ${step.id}`);
      }
    }
    for (const domain of step.conflictDomains ?? []) {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(domain)) {
        errors.push(`Invalid conflict domain ${domain} referenced by ${step.id}`);
      }
    }
    for (const predecessor of step.mustRunAfter ?? []) {
      if (!ids.has(predecessor)) {
        errors.push(`Unknown predecessor ${predecessor} referenced by ${step.id}`);
      }
    }
    for (const transfer of step.ownershipTransfers ?? []) {
      if (!ids.has(transfer)) {
        errors.push(`Unknown ownership transfer target ${transfer} referenced by ${step.id}`);
      }
    }
    for (const child of step.children) {
      if (child.startsWith('subtask-')) {
        continue;
      }
      if (!ids.has(child)) {
        errors.push(`Unknown child ${child} referenced by ${step.id}`);
      }
    }
  }

  const graph = buildPlannerExecutionGraph(plan);
  if (hasDependencyCycle(graph)) {
    errors.push('Plan contains at least one dependency cycle.');
  }

  return errors;
}

function normalizePlannerStep(step: unknown, index: number, workspaceRoot: string): PlannerStep {
  const record = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? `step-${index + 1}`),
    title: String(record.title ?? `Step ${index + 1}`),
    status: normalizeStepStatus(record.status),
    kind: normalizeStepKind(record.kind),
    attempts: normalizeStepAttempts(record.attempts),
    ...(typeof record.details === 'string' ? { details: record.details } : {}),
    ...(Array.isArray(record.relatedFiles)
      ? { relatedFiles: record.relatedFiles.filter((item): item is string => typeof item === 'string').map((item) => normalizePlannerFilePath(workspaceRoot, item)) }
      : {}),
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.filter((item): item is string => typeof item === 'string')
      : [],
    children: Array.isArray(record.children)
      ? record.children.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof record.maxAttempts === 'number' && Number.isFinite(record.maxAttempts) ? { maxAttempts: Math.max(1, Math.floor(record.maxAttempts)) } : {}),
    ...(typeof record.assignee === 'string' ? { assignee: record.assignee } : {}),
    ...(typeof record.executionState === 'string' ? { executionState: normalizeStepExecutionState(record.executionState) } : {}),
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
    ...(typeof record.failureKind === 'string' ? { failureKind: normalizeFailureKind(record.failureKind) } : {}),
    ...(Array.isArray(record.fallbackStepIds)
      ? { fallbackStepIds: record.fallbackStepIds.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(Array.isArray(record.dependsOnFiles)
      ? { dependsOnFiles: record.dependsOnFiles.filter((item): item is string => typeof item === 'string').map((item) => normalizePlannerFilePath(workspaceRoot, item)) }
      : {}),
    ...(Array.isArray(record.producesFiles)
      ? { producesFiles: record.producesFiles.filter((item): item is string => typeof item === 'string').map((item) => normalizePlannerFilePath(workspaceRoot, item)) }
      : {}),
    ...(Array.isArray(record.fileScope)
      ? { fileScope: record.fileScope.filter((item): item is string => typeof item === 'string').map((item) => normalizePlannerFilePath(workspaceRoot, item)) }
      : {}),
    ...(typeof record.accessMode === 'string' && (record.accessMode === 'read' || record.accessMode === 'write' || record.accessMode === 'verify')
      ? { accessMode: record.accessMode }
      : {}),
    ...(typeof record.failureTolerance === 'string' ? { failureTolerance: normalizeFailureTolerance(record.failureTolerance) } : {}),
    ...(Array.isArray(record.conflictsWith)
      ? { conflictsWith: record.conflictsWith.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(Array.isArray(record.conflictDomains)
      ? { conflictDomains: record.conflictDomains.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(Array.isArray(record.mustRunAfter)
      ? { mustRunAfter: record.mustRunAfter.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(Array.isArray(record.ownershipTransfers)
      ? { ownershipTransfers: record.ownershipTransfers.filter((item): item is string => typeof item === 'string') }
      : {}),
    ...(record.subtaskContext && typeof record.subtaskContext === 'object'
      ? { subtaskContext: record.subtaskContext as PlannerContextPacket }
      : {}),
  };
}

function normalizeStepAttempts(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function normalizeStepKind(kind: unknown): PlannerStep['kind'] {
  return kind === 'search' || kind === 'code' || kind === 'test' || kind === 'verify' || kind === 'docs' || kind === 'note'
    ? kind
    : 'note';
}

function normalizeStepStatus(status: unknown): PlannerStepStatus {
  return status === 'PENDING' || status === 'SEARCHING' || status === 'PATCHING' || status === 'VERIFYING' || status === 'FAILED' || status === 'DONE'
    ? status
    : 'PENDING';
}

function normalizeStepExecutionState(value: string): PlannerStepExecutionState {
  return value === 'idle' || value === 'ready' || value === 'running' || value === 'retrying' || value === 'fallback' || value === 'blocked' || value === 'done' || value === 'failed'
    ? value
    : 'idle';
}

function normalizeFailureKind(value: string): PlannerFailureKind {
  return value === 'tool' || value === 'model' || value === 'verify' || value === 'dependency' || value === 'policy' || value === 'conflict' || value === 'replan_required'
    ? value
    : 'model';
}

function normalizeFailureTolerance(value: string): PlannerFailureTolerance {
  return value === 'degrade' ? 'degrade' : 'none';
}

function withOptionalThought<T extends PlannerResponse>(step: T, thought: unknown): T {
  if (typeof thought === 'string') {
    return {
      ...step,
      thought,
    };
  }

  return step;
}
