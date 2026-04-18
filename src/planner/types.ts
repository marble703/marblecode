export type PlannerStepStatus = 'PENDING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'FAILED' | 'DONE';

export type PlannerPhase = 'PENDING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING';

export type PlannerOutcome = 'RUNNING' | 'FAILED' | 'DONE' | 'CANCELLED' | 'NEEDS_INPUT';

export type PlannerStepKind = 'search' | 'code' | 'test' | 'verify' | 'docs' | 'note';

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
  details?: string;
  relatedFiles?: string[];
  dependencies: string[];
  children: string[];
  assignee?: string;
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
  invalidResponseAttempts: number;
  message: string;
  consistencyErrors: string[];
}
