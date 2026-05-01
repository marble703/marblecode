import type { PlannerRuntimeLock, PlannerRuntimeTask } from './execution-runtime-types.js';

export function canAcquireRuntimeLocks(locks: PlannerRuntimeLock[], task: PlannerRuntimeTask): boolean {
  if (task.accessMode !== 'write') {
    return true;
  }
  if (task.fileScope.length === 0) {
    return locks.length === 0;
  }

  return task.fileScope.every((path) => !locks.some((lock) => lock.path === path && lock.ownerTaskId !== task.id));
}

export function acquireRuntimeLocks(locks: PlannerRuntimeLock[], task: PlannerRuntimeTask): PlannerRuntimeLock[] {
  if (task.accessMode !== 'write' || task.fileScope.length === 0) {
    return locks;
  }

  const next = locks.filter((lock) => lock.ownerTaskId !== task.id);
  return [
    ...next,
    ...task.fileScope.map((path) => ({ path, ownerTaskId: task.id })),
  ];
}

export function releaseRuntimeLocks(locks: PlannerRuntimeLock[], taskId: string): PlannerRuntimeLock[] {
  return locks.filter((lock) => lock.ownerTaskId !== taskId);
}
