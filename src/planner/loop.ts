import { invokeWithRetry } from '../provider/retry.js';
import type { ModelProvider } from '../provider/types.js';
import { appendSessionLog, writeSessionArtifact, type SessionRecord } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  appendPlannerEvent,
  appendPlannerStructuredLog,
} from './artifacts.js';
import { executePlannerPlan } from './execute.js';
import { buildPlannerModelRequest } from './model.js';
import { applyPlanUpdate, normalizePlannerPlan, parsePlannerResponse, runPlanConsistencyChecks } from './parse.js';
import { refreshPlannerStateFromPlan, statusToPhase } from './state.js';
import type { PlannerContextPacket, PlannerPlan, PlannerResponse, PlannerState } from './types.js';
import {
  buildPlannerProviderFailureMessage,
  classifyPlannerStep,
  mapPlannerResult,
  type RunPlannerInput,
  type RunPlannerResult,
  updatePlannerStep,
} from './runtime.js';
import {
  buildPlannerModelAliasCandidates,
  shouldFallbackPlannerModel,
} from './utils.js';
import type { AppConfig } from '../config/schema.js';
import type { PlannerRequestArtifact } from './types.js';

const MAX_INVALID_RESPONSE_RETRIES = 3;

export async function runPlannerLoop(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  session: SessionRecord,
  input: RunPlannerInput,
  requestArtifact: PlannerRequestArtifact,
  combinedPrompt: string,
  route: { modelAlias: string; maxSteps: number },
  context: Awaited<ReturnType<typeof import('../context/index.js').buildContext>>,
  contextPacket: PlannerContextPacket,
  plan: PlannerPlan,
  state: PlannerState,
  nextRevision: number,
): Promise<RunPlannerResult> {
  const plannerModelAliases = buildPlannerModelAliasCandidates(config, route.modelAlias);
  let plannerModelIndex = 0;
  const toolDefinitions = tools.listDefinitions();
  const transcript: string[] = [];
  let stepCount = 0;

  while (stepCount < route.maxSteps) {
    const plannerModelAlias = plannerModelAliases[plannerModelIndex];
    if (!plannerModelAlias) {
      throw new Error('No planning model aliases are available.');
    }
    const modelConfig = config.models[plannerModelAlias];
    if (!modelConfig) {
      throw new Error(`Unknown planning model alias: ${plannerModelAlias}`);
    }
    const provider = providers.get(modelConfig.provider);
    if (!provider) {
      throw new Error(`Provider ${modelConfig.provider} is not available`);
    }

    const request = buildPlannerModelRequest(
      config,
      modelConfig.model,
      modelConfig.provider,
      combinedPrompt,
      context,
      transcript,
      toolDefinitions,
      plan,
      state,
      contextPacket,
      Boolean(input.executeSubtasks),
    );

    let response;
    try {
      response = await invokeWithRetry(config, provider, request, async (event) => {
        await appendPlannerEvent(session, {
          type: 'planner_model_retry',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
        }, config.session.redactSecrets);
        await appendPlannerStructuredLog(session, {
          type: 'model_retry',
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          delayMs: event.delayMs,
          reason: event.reason,
        }, config.session.redactSecrets);
      });
    } catch (error) {
      const fallbackAlias = plannerModelAliases[plannerModelIndex + 1];
      if (fallbackAlias && shouldFallbackPlannerModel(error)) {
        plannerModelIndex += 1;
        await appendPlannerEvent(session, {
          type: 'planner_model_fallback',
          fromModelAlias: plannerModelAlias,
          toModelAlias: fallbackAlias,
          reason: error instanceof Error ? error.message : String(error),
        }, config.session.redactSecrets);
        await appendPlannerStructuredLog(session, {
          type: 'model_fallback',
          fromModelAlias: plannerModelAlias,
          toModelAlias: fallbackAlias,
          reason: error instanceof Error ? error.message : String(error),
        }, config.session.redactSecrets);
        transcript.push(`host_notice:planner model fallback from ${plannerModelAlias} to ${fallbackAlias}`);
        continue;
      }

      state.outcome = 'FAILED';
      state.message = buildPlannerProviderFailureMessage(error, config.session.modelRetryAttempts);
      await appendPlannerStructuredLog(session, {
        type: 'model_failure',
        error: error instanceof Error ? error.message : String(error),
        retryAttempts: config.session.modelRetryAttempts,
      }, config.session.redactSecrets);
      await appendPlannerStructuredLog(session, {
        type: 'planner_terminal',
        outcome: state.outcome,
        message: state.message,
        summary: plan.summary,
        consistencyErrors: state.consistencyErrors,
      }, config.session.redactSecrets);
      await appendPlannerEvent(session, {
        type: 'planner_failed',
        reason: state.message,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
      return mapPlannerResult('FAILED', session.dir, state.message);
    }

    await appendSessionLog(
      session,
      'model.jsonl',
      {
        mode: 'planner',
        stopReason: response.stopReason,
        usage: response.usage,
        content: config.session.logPromptBodies ? response.content : '[omitted]',
      },
      config.session.redactSecrets,
    );

    let step: PlannerResponse;
    try {
      step = parsePlannerResponse(response.content);
      state.invalidResponseAttempts = 0;
      await appendPlannerStructuredLog(session, step, config.session.redactSecrets);
    } catch (error) {
      state.invalidResponseAttempts += 1;
      state.outcome = 'RUNNING';
      state.message = error instanceof Error ? error.message : String(error);
      await appendPlannerStructuredLog(session, {
        type: 'invalid_response',
        error: state.message,
        attempts: state.invalidResponseAttempts,
      }, config.session.redactSecrets);
      await appendPlannerEvent(session, {
        type: 'planner_invalid_output',
        attempt: state.invalidResponseAttempts,
        maxAttempts: MAX_INVALID_RESPONSE_RETRIES,
        error: state.message,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));

      if (state.invalidResponseAttempts >= MAX_INVALID_RESPONSE_RETRIES) {
        state.outcome = 'FAILED';
        state.message = `Planner failed after ${MAX_INVALID_RESPONSE_RETRIES} invalid responses.`;
        await appendPlannerEvent(session, { type: 'planner_failed', reason: state.message }, config.session.redactSecrets);
        await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
        return mapPlannerResult('FAILED', session.dir, state.message);
      }

      transcript.push(`host_error:${state.message}`);
      continue;
    }

    transcript.push(`assistant:${response.content}`);

    if (step.type === 'tool_call') {
      const toolResult = await tools.execute({ name: step.tool, input: step.input });
      await appendSessionLog(
        session,
        'tools.jsonl',
        {
          mode: 'planner',
          tool: step.tool,
          input: config.session.logToolBodies ? step.input : '[omitted]',
          result: config.session.logToolBodies ? toolResult : { ok: toolResult.ok },
        },
        config.session.redactSecrets,
      );
      await appendPlannerEvent(session, {
        type: 'tool_result',
        tool: step.tool,
        ok: toolResult.ok,
        error: toolResult.ok ? '' : toolResult.error ?? '',
      }, config.session.redactSecrets);
      transcript.push(`tool:${JSON.stringify({ tool: step.tool, result: toolResult })}`);
      stepCount += 1;
      continue;
    }

    if (step.type === 'plan') {
      plan = normalizePlannerPlan(step.plan, nextRevision, config.workspaceRoot);
      state.revision = plan.revision;
      state.message = plan.summary;
      state.phase = 'PLANNING';
      state.currentStepId = null;
      state.consistencyErrors = runPlanConsistencyChecks(plan);
      state = refreshPlannerStateFromPlan(plan, state);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(plan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
      await appendPlannerStructuredLog(session, {
        type: 'plan_snapshot',
        revision: plan.revision,
        summary: plan.summary,
        steps: plan.steps,
      }, config.session.redactSecrets);
      await appendPlannerEvent(session, {
        type: 'plan_set',
        revision: plan.revision,
        summary: plan.summary,
        stepCount: plan.steps.length,
      }, config.session.redactSecrets);
      stepCount += 1;
      continue;
    }

    if (step.type === 'plan_update') {
      plan = applyPlanUpdate(plan, step);
      state.phase = statusToPhase(step.status);
      state.currentStepId = step.stepId;
      if (step.message) {
        state.message = step.message;
      }
      state = refreshPlannerStateFromPlan(plan, state);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(plan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
      await appendPlannerStructuredLog(session, {
        type: 'plan_snapshot',
        revision: plan.revision,
        summary: plan.summary,
        steps: plan.steps,
      }, config.session.redactSecrets);
      await appendPlannerEvent(session, {
        type: 'plan_step_updated',
        stepId: step.stepId,
        status: step.status,
        message: step.message ?? '',
      }, config.session.redactSecrets);
      stepCount += 1;
      continue;
    }

    if (step.summary) {
      plan.summary = step.summary;
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(plan, null, 2));
    }
    state.outcome = step.outcome ?? 'DONE';
    state.currentStepId = null;
    state.consistencyErrors = runPlanConsistencyChecks(plan);
    state = refreshPlannerStateFromPlan(plan, state);
    if (state.outcome === 'DONE' && state.consistencyErrors.length > 0) {
      state.outcome = 'FAILED';
      state.message = `Planner consistency check failed: ${state.consistencyErrors.join('; ')}`;
    } else {
      state.message = step.message;
    }

    if (state.outcome === 'DONE' && input.executeSubtasks && plan.steps.length === 0) {
      state.outcome = 'FAILED';
      state.message = 'Planner did not produce a structured plan with executable steps.';
    }

    if (state.outcome === 'DONE' && input.executeSubtasks) {
      const executionResult = await executePlannerPlan(config, providers, session, requestArtifact, plan, state, {
        classifyPlannerStep,
        updatePlannerStep,
      });
      plan = executionResult.plan;
      state = executionResult.state;
    }

    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
    await appendPlannerStructuredLog(session, {
      type: 'planner_terminal',
      outcome: state.outcome,
      message: state.message,
      summary: plan.summary,
      consistencyErrors: state.consistencyErrors,
    }, config.session.redactSecrets);
    await appendPlannerEvent(session, {
      type: 'planner_finished',
      outcome: state.outcome,
      message: state.message,
      consistencyErrors: state.consistencyErrors,
    }, config.session.redactSecrets);
    if (state.outcome === 'RUNNING') {
      state.outcome = 'FAILED';
      state.message = 'Planner ended without a terminal outcome.';
    }
    return mapPlannerResult(state.outcome, session.dir, state.message);
  }

  state.outcome = 'FAILED';
  state.message = 'Planner reached the maximum step limit and needs user intervention.';
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
  await appendPlannerEvent(session, { type: 'planner_failed', reason: state.message }, config.session.redactSecrets);
  return mapPlannerResult('FAILED', session.dir, state.message);
}
