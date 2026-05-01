import { deriveReadyRuntimeTaskIds } from './execution-runtime-state.js';
import { canAcquireRuntimeLocks } from './simple-locks.js';
import type { PlannerRuntimeState, PlannerRuntimeTask } from './execution-runtime-types.js';

export function getReadyRuntimeTasks(state: PlannerRuntimeState): PlannerRuntimeTask[] {
  const readyIds = new Set(deriveReadyRuntimeTaskIds(state));
  return state.tasks.filter((task) => readyIds.has(task.id));
}

export function selectRunnableRuntimeBatch(
  state: PlannerRuntimeState,
  maxConcurrentSubtasks: number,
): PlannerRuntimeTask[] {
  return selectRunnableRuntimeBatchFromCandidates(getReadyRuntimeTasks(state), maxConcurrentSubtasks, state.locks);
}

export function selectRunnableRuntimeBatchFromCandidates(
  candidateTasks: PlannerRuntimeTask[],
  maxConcurrentSubtasks: number,
  locks: PlannerRuntimeState['locks'],
): PlannerRuntimeTask[] {
  const readyTasks = candidateTasks;
  const verifyTask = readyTasks.find((task) => task.accessMode === 'verify');
  if (verifyTask) {
    return [verifyTask];
  }

  const selected: PlannerRuntimeTask[] = [];
  for (const task of readyTasks) {
    if (selected.length >= Math.max(1, maxConcurrentSubtasks)) {
      break;
    }
    const activeLocks = [
      ...locks,
      ...selected.flatMap((selectedTask) => selectedTask.accessMode === 'write'
        ? selectedTask.fileScope.map((path) => ({ path, ownerTaskId: selectedTask.id }))
        : []),
    ];
    if (!canAcquireRuntimeLocks(activeLocks, task)) {
      continue;
    }
    if (task.accessMode === 'write' && task.fileScope.length === 0 && selected.length > 0) {
      continue;
    }
    if (selected.some((candidate) => runtimeTasksConflict(candidate, task))) {
      continue;
    }
    selected.push(task);
    if (task.accessMode === 'write' && task.fileScope.length === 0) {
      break;
    }
  }

  return selected;
}

function runtimeTasksConflict(left: PlannerRuntimeTask, right: PlannerRuntimeTask): boolean {
  if (left.accessMode === 'verify' || right.accessMode === 'verify') {
    return true;
  }
  if (left.accessMode === 'read' && right.accessMode === 'read') {
    return false;
  }

  const rightDomains = new Set(right.conflictDomains);
  if (left.conflictDomains.some((domain) => rightDomains.has(domain))) {
    return true;
  }

  if (left.accessMode !== 'write' && right.accessMode !== 'write') {
    return false;
  }
  if (left.fileScope.length === 0 || right.fileScope.length === 0) {
    return left.accessMode === 'write' || right.accessMode === 'write';
  }

  const rightScope = new Set(right.fileScope);
  return left.fileScope.some((path) => rightScope.has(path));
}
