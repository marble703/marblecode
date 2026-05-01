import type { PlannerAccessMode, PlannerStep } from './types.js';

export function derivePlannerAccessMode(step: PlannerStep): PlannerAccessMode {
  if (step.accessMode) {
    return step.accessMode;
  }
  if (step.kind === 'verify') {
    return 'verify';
  }
  if (step.kind === 'search' || step.kind === 'note') {
    return 'read';
  }
  return 'write';
}

export function derivePlannerFileScope(step: PlannerStep): string[] {
  const scope = step.fileScope ?? step.producesFiles ?? step.relatedFiles ?? [];
  return [...new Set(scope)];
}

export function derivePlannerConflicts(step: PlannerStep): string[] {
  return [...new Set(step.conflictsWith ?? [])];
}

export function derivePlannerConflictDomains(step: PlannerStep): string[] {
  return [...new Set(step.conflictDomains ?? [])];
}
