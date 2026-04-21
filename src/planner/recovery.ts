import { invokeWithRetry } from '../provider/retry.js';
import type { ModelProvider } from '../provider/types.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { AppConfig } from '../config/schema.js';
import { appendPlannerEvent, appendPlannerStructuredLog } from './artifacts.js';
import { normalizePlannerPlan, parsePlannerResponse, runPlanConsistencyChecks } from './parse.js';
import { buildPlannerNodeReplanRequest } from './prompts.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import { buildPlannerModelAliasCandidates, mergeStringLists } from './utils.js';

export async function attemptPlannerNodeReplan(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  failedStepId: string,
  failureMessage: string,
): Promise<{ plan: PlannerPlan; state: PlannerState } | null> {
  const failedStep = plan.steps.find((step) => step.id === failedStepId);
  if (!failedStep) {
    return null;
  }

  const plannerAliases = buildPlannerModelAliasCandidates(config, config.routing.planningModel);
  for (const alias of plannerAliases) {
    const modelConfig = config.models[alias];
    if (!modelConfig) {
      continue;
    }
    const provider = providers.get(modelConfig.provider);
    if (!provider) {
      continue;
    }

    try {
      const response = await invokeWithRetry(config, provider, buildPlannerNodeReplanRequest(modelConfig.provider, modelConfig.model, requestArtifact, plan, state, failedStep, failureMessage));
      const parsed = parsePlannerResponse(response.content);
      if (parsed.type === 'final') {
        if (parsed.outcome === 'NEEDS_INPUT' || parsed.outcome === 'FAILED') {
          return null;
        }
        continue;
      }
      if (parsed.type !== 'plan') {
        continue;
      }

      const replanned = normalizePlannerPlan(parsed.plan, plan.revision + 1, config.workspaceRoot);
      const merged = mergeReplannedPlan(plan, replanned, failedStepId, failureMessage);
      const nextState = refreshPlannerStateFromPlan(merged, {
        ...state,
        revision: merged.revision,
        phase: 'REPLANNING',
        message: `Planner replanned after step ${failedStepId} failed.`,
        lastReplanReason: `${failedStepId}: ${failureMessage}`,
        consistencyErrors: runPlanConsistencyChecks(merged),
      });
      await appendPlannerEvent(session, {
        type: 'subtask_replanned',
        stepId: failedStepId,
        modelAlias: alias,
        reason: failureMessage,
        revision: merged.revision,
      }, config.session.redactSecrets);
      await appendPlannerStructuredLog(session, {
        type: 'plan_snapshot',
        revision: merged.revision,
        summary: merged.summary,
        steps: merged.steps,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(merged, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      return { plan: merged, state: nextState };
    } catch (error) {
      await appendPlannerEvent(session, {
        type: 'subtask_replan_failed',
        stepId: failedStepId,
        modelAlias: alias,
        reason: error instanceof Error ? error.message : String(error),
      }, config.session.redactSecrets);
    }
  }

  return null;
}

function mergeReplannedPlan(previousPlan: PlannerPlan, replannedPlan: PlannerPlan, failedStepId: string, failureMessage: string): PlannerPlan {
  const previousSteps = new Map(previousPlan.steps.map((step) => [step.id, step]));
  const completed = previousPlan.steps.filter((step) => step.status === 'DONE');
  for (const step of completed) {
    if (!replannedPlan.steps.some((candidate) => candidate.id === step.id)) {
      throw new Error(`Replanned plan removed completed step ${step.id}`);
    }
  }

  return {
    ...replannedPlan,
    steps: replannedPlan.steps.map((step) => {
      const previous = previousSteps.get(step.id);
      if (previous?.status === 'DONE') {
        const completedStep: PlannerStep = {
          ...step,
          status: 'DONE',
          attempts: previous.attempts,
          executionState: 'done',
          relatedFiles: mergeStringLists(step.relatedFiles ?? [], previous.relatedFiles ?? []),
          producesFiles: mergeStringLists(step.producesFiles ?? [], previous.producesFiles ?? []),
        };
        if (previous.lastError) {
          completedStep.lastError = previous.lastError;
        }
        return completedStep;
      }
      if (step.id === failedStepId) {
        return {
          ...step,
          attempts: 0,
          executionState: 'idle',
          lastError: failureMessage,
          failureKind: 'replan_required',
          status: 'PENDING',
        };
      }
      return step;
    }),
  };
}
