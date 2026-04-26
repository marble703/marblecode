import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from '../provider/types.js';
import type { SessionRecord } from '../session/index.js';
import type { PlannerExecutionArtifacts } from './execution-types.js';
import type { PlannerRequestArtifact, PlannerPlan, PlannerState, PlannerStep } from './types.js';
import { executePlannerPlan } from './execute.js';
import { classifyPlannerStep, updatePlannerStep } from './runtime.js';

export async function resumePlannerExecution(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  artifacts: PlannerExecutionArtifacts,
): Promise<{ plan: PlannerPlan; state: PlannerState }> {
  const interruptedStepIds = artifacts.executionState.activeStepIds;
  const resumableStepIds = planResumableStepIds(artifacts.plan);
  let plan = artifacts.plan;
  let state = artifacts.state;

  if (interruptedStepIds.length > 0 || resumableStepIds.length > 0) {
    const stepIdsToReset = interruptedStepIds.length > 0 ? interruptedStepIds : resumableStepIds;
    for (const stepId of stepIdsToReset) {
      const step = plan.steps.find((candidate) => candidate.id === stepId);
      if (!step || step.status === 'DONE') {
        continue;
      }
      plan = updatePlannerStep(plan, stepId, {
        status: 'PENDING',
        executionState: 'idle',
        lastError: `Interrupted during ${artifacts.executionState.executionPhase}; resuming through recovery path.`,
        details: `Interrupted during ${artifacts.executionState.executionPhase}; resuming through recovery path.`,
      });
    }
    state = {
      ...state,
      phase: 'RETRYING',
      outcome: 'RUNNING',
      failedStepIds: [],
      blockedStepIds: [],
      activeStepIds: [],
      readyStepIds: [],
      message: stepIdsToReset.length === 1
        ? `Resuming interrupted execution for ${stepIdsToReset[0]}.`
        : `Resuming interrupted execution for ${stepIdsToReset.join(', ')}.`,
    };
  }

  return executePlannerPlan(config, providers, session, requestArtifact, plan, state, {
    classifyPlannerStep,
    updatePlannerStep,
  });
}

function planResumableStepIds(plan: PlannerPlan): string[] {
  return plan.steps
    .filter((step) => step.status !== 'DONE')
    .map((step) => step.id);
}
