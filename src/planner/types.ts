export type PlannerStepStatus = 'PENDING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'FAILED' | 'DONE';

export type PlannerPhase = 'PENDING' | 'PLANNING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'RETRYING' | 'REPLANNING' | 'BLOCKED';

export type PlannerOutcome = 'RUNNING' | 'FAILED' | 'DONE' | 'CANCELLED' | 'NEEDS_INPUT';

export type PlannerStepKind = 'search' | 'code' | 'test' | 'verify' | 'docs' | 'note';

export type PlannerStepExecutionState = 'idle' | 'ready' | 'running' | 'retrying' | 'fallback' | 'blocked' | 'done' | 'failed';

export type PlannerFailureKind = 'tool' | 'model' | 'verify' | 'dependency' | 'policy' | 'conflict' | 'replan_required';

export interface PlannerContextPacket {
  version: '1';
  objective: string;
  request: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  queryTerms: string[];
  contextItems: Array<{
    path: string;
    source: string;
    reason: string;
  }>;
  constraints: {
    readOnly: boolean;
    allowedTools: string[];
    maxSteps: number;
  };
  planRevision: number;
  parentStepId?: string;
}

export interface PlannerStep {
  id: string;
  title: string;
  status: PlannerStepStatus;
  kind: PlannerStepKind;
  attempts: number;
  details?: string;
  relatedFiles?: string[];
  dependencies: string[];
  children: string[];
  maxAttempts?: number;
  assignee?: string;
  executionState?: PlannerStepExecutionState;
  lastError?: string;
  failureKind?: PlannerFailureKind;
  fallbackStepIds?: string[];
  dependsOnFiles?: string[];
  producesFiles?: string[];
  subtaskContext?: PlannerContextPacket;
}

export interface PlannerPlan {
  version: '1';
  revision: number;
  summary: string;
  steps: PlannerStep[];
}

export interface PlannerState {
  version: '1';
  revision: number;
  phase: PlannerPhase;
  outcome: PlannerOutcome;
  currentStepId: string | null;
  activeStepIds: string[];
  readyStepIds: string[];
  completedStepIds: string[];
  failedStepIds: string[];
  blockedStepIds: string[];
  invalidResponseAttempts: number;
  message: string;
  consistencyErrors: string[];
  lastReplanReason?: string;
}
