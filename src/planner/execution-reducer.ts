import { acquireRuntimeLocks, releaseRuntimeLocks } from './simple-locks.js';
import type { PlannerRuntimeState } from './execution-runtime-types.js';

export type PlannerRuntimeEvent =
  | { type: 'TASK_STARTED'; taskId: string }
  | { type: 'TASK_SUCCEEDED'; taskId: string; changedFiles: string[] }
  | { type: 'TASK_FAILED'; taskId: string; message: string }
  | { type: 'TASK_DEGRADED'; taskId: string; message: string }
  | { type: 'EXECUTION_COMPLETED'; message: string }
  | { type: 'EXECUTION_FAILED'; message: string };

export function reducePlannerRuntimeState(state: PlannerRuntimeState, event: PlannerRuntimeEvent): PlannerRuntimeState {
  if (event.type === 'EXECUTION_COMPLETED') {
    return {
      ...state,
      phase: 'done',
      message: event.message,
    };
  }
  if (event.type === 'EXECUTION_FAILED') {
    return {
      ...state,
      phase: 'failed',
      message: event.message,
    };
  }

  const task = state.tasks.find((candidate) => candidate.id === event.taskId);
  if (!task) {
    return state;
  }

  if (event.type === 'TASK_STARTED') {
    return {
      ...state,
      phase: task.accessMode === 'verify' ? 'verifying' : 'running',
      epoch: state.epoch + 1,
      locks: acquireRuntimeLocks(state.locks, task),
      tasks: state.tasks.map((candidate) => candidate.id === event.taskId
        ? { ...candidate, status: 'running' }
        : candidate),
    };
  }

  if (event.type === 'TASK_SUCCEEDED') {
    return {
      ...state,
      locks: releaseRuntimeLocks(state.locks, event.taskId),
      tasks: state.tasks.map((candidate) => candidate.id === event.taskId
        ? { ...candidate, status: 'done', changedFiles: event.changedFiles, lastError: '' }
        : candidate),
    };
  }

  if (event.type === 'TASK_FAILED') {
    return {
      ...state,
      locks: releaseRuntimeLocks(state.locks, event.taskId),
      tasks: state.tasks.map((candidate) => candidate.id === event.taskId
        ? { ...candidate, status: 'failed', lastError: event.message }
        : candidate),
    };
  }

  return {
    ...state,
    locks: releaseRuntimeLocks(state.locks, event.taskId),
    tasks: state.tasks.map((candidate) => candidate.id === event.taskId
      ? { ...candidate, status: 'degraded', lastError: event.message }
      : candidate),
  };
}
