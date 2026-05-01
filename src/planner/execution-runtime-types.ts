import type { PlannerAccessMode, PlannerDependencyTolerance, PlannerFailureTolerance, PlannerStepKind } from './types.js';

export type PlannerRuntimeTaskStatus = 'pending' | 'running' | 'done' | 'failed' | 'blocked' | 'degraded';

export interface PlannerRuntimeTask {
  id: string;
  stepId: string;
  title: string;
  kind: PlannerStepKind;
  status: PlannerRuntimeTaskStatus;
  dependsOn: string[];
  fileScope: string[];
  accessMode: PlannerAccessMode;
  conflictDomains: string[];
  attempts: number;
  maxAttempts: number;
  failureTolerance: PlannerFailureTolerance;
  dependencyTolerances?: Record<string, PlannerDependencyTolerance>;
  changedFiles: string[];
  lastError?: string;
}

export interface PlannerRuntimeLock {
  path: string;
  ownerTaskId: string;
}

export interface PlannerRuntimeState {
  version: '1';
  revision: number;
  phase: 'idle' | 'running' | 'verifying' | 'done' | 'failed';
  tasks: PlannerRuntimeTask[];
  locks: PlannerRuntimeLock[];
  epoch: number;
  message: string;
}
