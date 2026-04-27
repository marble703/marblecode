import { invokeWithRetry } from '../provider/retry.js';
import type { ModelProvider } from '../provider/types.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { AppConfig } from '../config/schema.js';
import { appendPlannerEvent, appendPlannerStructuredLog } from './artifacts.js';
import { normalizePlannerPlan, parsePlannerResponse, runPlanConsistencyChecks } from './parse.js';
import { buildPlannerNodeReplanRequest } from './prompts.js';
import { buildReplanProposal, mergeReplanProposal } from './replan-merge.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState } from './types.js';
import { buildPlannerModelAliasCandidates } from './utils.js';

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
      const proposal = buildReplanProposal({
        failedStepId,
        failureMessage,
        previousPlan: plan,
        proposedPlan: replanned,
      });
      const proposalArtifact = `replan.proposal.${failedStepId}.json`;
      await writeSessionArtifact(session, proposalArtifact, JSON.stringify(proposal, null, 2));
      await appendPlannerEvent(session, {
        type: 'subtask_replan_proposed',
        stepId: failedStepId,
        modelAlias: alias,
        proposalArtifact,
        revision: replanned.revision,
      }, config.session.redactSecrets);

      const merged = mergeReplanProposal(plan, replanned, failedStepId, failureMessage);
      if (!merged.validation.ok) {
        const rejectionArtifact = `replan.rejected.${failedStepId}.json`;
        await writeSessionArtifact(session, rejectionArtifact, JSON.stringify({
          version: '1',
          failedStepId,
          errors: merged.validation.errors,
          proposalArtifact,
        }, null, 2));
        await appendPlannerEvent(session, {
          type: 'subtask_replan_rejected',
          stepId: failedStepId,
          modelAlias: alias,
          proposalArtifact,
          rejectionArtifact,
          errors: merged.validation.errors,
        }, config.session.redactSecrets);
        await appendPlannerEvent(session, {
          type: 'subtask_replan_failed',
          stepId: failedStepId,
          modelAlias: alias,
          reason: merged.validation.errors.join('; '),
        }, config.session.redactSecrets);
        continue;
      }
      const nextPlan = merged.plan;
      const nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...state,
        revision: nextPlan.revision,
        phase: 'REPLANNING',
        message: `Planner replanned after step ${failedStepId} failed.`,
        lastReplanReason: `${failedStepId}: ${failureMessage}`,
        consistencyErrors: runPlanConsistencyChecks(nextPlan),
      });
      await appendPlannerEvent(session, {
        type: 'subtask_replan_merged',
        stepId: failedStepId,
        modelAlias: alias,
        proposalArtifact,
        revision: nextPlan.revision,
      }, config.session.redactSecrets);
      await appendPlannerEvent(session, {
        type: 'subtask_replanned',
        stepId: failedStepId,
        modelAlias: alias,
        reason: failureMessage,
        revision: nextPlan.revision,
      }, config.session.redactSecrets);
      await appendPlannerStructuredLog(session, {
        type: 'plan_snapshot',
        revision: nextPlan.revision,
        summary: nextPlan.summary,
        steps: nextPlan.steps,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      return { plan: nextPlan, state: nextState };
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
