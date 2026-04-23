export type PlannerStepStatus = 'PENDING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'FAILED' | 'DONE';

export type PlannerPhase = 'PENDING' | 'PLANNING' | 'SEARCHING' | 'PATCHING' | 'VERIFYING' | 'RETRYING' | 'REPLANNING' | 'BLOCKED';

export type PlannerOutcome = 'RUNNING' | 'FAILED' | 'DONE' | 'CANCELLED' | 'NEEDS_INPUT';

export type PlannerPlanPayload = Omit<PlannerPlan, 'revision'> & { revision?: number };

export type PlannerResponse =
  | {
      type: 'tool_call';
      thought?: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'plan';
      thought?: string;
      plan: PlannerPlanPayload;
    }
  | {
      type: 'plan_update';
      thought?: string;
      stepId: string;
      status: PlannerStepStatus;
      message?: string;
      relatedFiles?: string[];
    }
  | {
      type: 'final';
      thought?: string;
      message: string;
      outcome?: Exclude<PlannerOutcome, 'RUNNING'>;
      summary?: string;
    };

export type PlannerStepKind = 'search' | 'code' | 'test' | 'verify' | 'docs' | 'note';

export type PlannerStepExecutionState = 'idle' | 'ready' | 'running' | 'retrying' | 'fallback' | 'blocked' | 'done' | 'failed';

export type PlannerFailureKind = 'tool' | 'model' | 'verify' | 'dependency' | 'policy' | 'conflict' | 'stale_base' | 'replan_required';

export type PlannerAccessMode = 'read' | 'write' | 'verify';

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
  fileScope?: string[];
  accessMode?: PlannerAccessMode;
  conflictsWith?: string[];
  mustRunAfter?: string[];
  ownershipTransfers?: string[];
  subtaskContext?: PlannerContextPacket;
}

export interface PlannerPlan {
  version: '1';
  revision: number;
  summary: string;
  steps: PlannerStep[];
}

export interface PlannerRequestArtifact {
  promptHistory: string[];
  explicitFiles: string[];
  pastedSnippets: string[];
  resumedFrom: string | null;
}

export interface PlannerSessionArtifacts {
  request: PlannerRequestArtifact;
  plan: PlannerPlan;
  state: PlannerState;
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
