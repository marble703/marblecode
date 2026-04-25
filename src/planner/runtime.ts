import { refreshPlannerStateFromPlan } from './state.js';
import type {
  PlannerOutcome,
  PlannerPlan,
  PlannerRequestArtifact,
  PlannerSessionArtifacts,
  PlannerState,
  PlannerStep,
} from './types.js';

export interface RunPlannerInput {
  prompt: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  executeSubtasks?: boolean;
  resumeSessionRef?: string;
  useLatestSession?: boolean;
}

export interface RunPlannerResult {
  status: 'completed' | 'needs_input' | 'failed' | 'cancelled';
  sessionDir: string;
  message: string;
}

export function buildPlannerRequestArtifact(
  input: RunPlannerInput,
  sessionDir: string,
  prior: PlannerSessionArtifacts | undefined,
): PlannerRequestArtifact {
  const promptHistory = prior ? prior.request.promptHistory.slice() : [];
  const nextPrompt = input.prompt.trim();
  if (nextPrompt) {
    promptHistory.push(nextPrompt);
  }

  return {
    promptHistory,
    explicitFiles: input.explicitFiles.length > 0 ? input.explicitFiles : prior?.request.explicitFiles ?? [],
    pastedSnippets: input.pastedSnippets.length > 0 ? input.pastedSnippets : prior?.request.pastedSnippets ?? [],
    resumedFrom: prior ? sessionDir : null,
  };
}

export function determineNextRevision(prompt: string, prior: PlannerSessionArtifacts | undefined): number {
  if (!prior) {
    return 1;
  }

  return prompt.trim() ? prior.state.revision + 1 : prior.state.revision;
}

export function initializePlannerPlan(prior: PlannerPlan | undefined, revision: number, objective: string): PlannerPlan {
  if (prior) {
    return {
      ...prior,
      revision,
    };
  }

  return {
    version: '1',
    revision,
    summary: objective,
    steps: [],
  };
}

export function initializePlannerState(prior: PlannerState | undefined, revision: number, prompt: string, resumed: boolean): PlannerState {
  if (prior) {
    return refreshPlannerStateFromPlan(undefined, {
      ...prior,
      revision,
      outcome: 'RUNNING',
      phase: prompt.trim() ? 'REPLANNING' : 'PENDING',
      currentStepId: null,
      activeStepIds: [],
      readyStepIds: [],
      completedStepIds: [],
      failedStepIds: [],
      blockedStepIds: [],
      invalidResponseAttempts: 0,
      message: prompt.trim() ? 'Planner replanning with new input.' : 'Planner resumed.',
      consistencyErrors: [],
      ...(prompt.trim() ? { lastReplanReason: prompt.trim() } : {}),
    });
  }

  return refreshPlannerStateFromPlan(undefined, {
    version: '1',
    revision,
    phase: resumed ? 'PENDING' : 'PLANNING',
    outcome: 'RUNNING',
    currentStepId: null,
    activeStepIds: [],
    readyStepIds: [],
    completedStepIds: [],
    failedStepIds: [],
    blockedStepIds: [],
    invalidResponseAttempts: 0,
    message: resumed ? 'Planner resumed.' : 'Planner started.',
    consistencyErrors: [],
  });
}

export function isTerminalOutcome(outcome: PlannerOutcome): boolean {
  return outcome === 'DONE' || outcome === 'FAILED' || outcome === 'CANCELLED' || outcome === 'NEEDS_INPUT';
}

export function mapPlannerResult(outcome: Exclude<PlannerOutcome, 'RUNNING'>, sessionDir: string, message: string): RunPlannerResult {
  if (outcome === 'DONE') {
    return { status: 'completed', sessionDir, message };
  }
  if (outcome === 'NEEDS_INPUT') {
    return { status: 'needs_input', sessionDir, message };
  }
  if (outcome === 'CANCELLED') {
    return { status: 'cancelled', sessionDir, message };
  }
  return { status: 'failed', sessionDir, message };
}

export function classifyPlannerStep(step: PlannerStep): 'skip' | 'subagent' | 'verify' {
  const text = `${step.title} ${step.details ?? ''}`.toLowerCase();
  if (step.kind === 'verify') {
    return 'verify';
  }

  if (step.kind === 'search') {
    return 'skip';
  }

  if (/\bverify\b/.test(text)) {
    return 'verify';
  }

  if (step.kind === 'code' || step.kind === 'test' || step.kind === 'docs') {
    return 'subagent';
  }

  if (/修复|修改|重构|更新|补充|测试|fix|modify|refactor|update|test|implement/.test(text)) {
    return 'subagent';
  }

  return 'skip';
}

export function updatePlannerStep(
  plan: PlannerPlan,
  stepId: string,
  updates: Partial<PlannerStep>,
): PlannerPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
  };
}

export function buildPlannerProviderFailureMessage(error: unknown, retryAttempts: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Planner model request failed after ${retryAttempts} retries. ${reason}`;
}
