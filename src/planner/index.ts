import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { runAgent } from '../agent/index.js';
import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider, ModelRequest } from '../provider/types.js';
import { invokeWithRetry } from '../provider/retry.js';
import { routeTask } from '../router/index.js';
import { appendSessionLog, createSession, resolveSessionDir, writeSessionArtifact, type SessionRecord } from '../session/index.js';
import { createBuiltinTools } from '../tools/builtins.js';
import { ToolRegistry } from '../tools/registry.js';
import { runVerifier } from '../verifier/index.js';
import type { PlannerContextPacket, PlannerOutcome, PlannerPhase, PlannerPlan, PlannerState, PlannerStep, PlannerStepStatus } from './types.js';

const MAX_INVALID_RESPONSE_RETRIES = 3;

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

type PlannerPlanPayload = Omit<PlannerPlan, 'revision'> & { revision?: number };

type PlannerResponse =
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

interface PlannerRequestArtifact {
  promptHistory: string[];
  explicitFiles: string[];
  pastedSnippets: string[];
  resumedFrom: string | null;
}

interface PlannerSessionArtifacts {
  request: PlannerRequestArtifact;
  plan: PlannerPlan;
  state: PlannerState;
}

export async function runPlanner(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  input: RunPlannerInput,
): Promise<RunPlannerResult> {
  const resumed = input.resumeSessionRef || input.useLatestSession;
  const session = resumed ? await resumePlannerSession(config, input.resumeSessionRef, input.useLatestSession) : await createSession(config);
  const prior = resumed ? await loadPlannerSessionArtifacts(session.dir) : undefined;

  const requestArtifact = buildPlannerRequestArtifact(input, session.dir, prior);
  if (requestArtifact.promptHistory.length === 0) {
    throw new Error('A prompt is required for a new plan, or provide --session/--last to resume an existing plan.');
  }

  const combinedPrompt = requestArtifact.promptHistory.join('\n\nAdditional planner input:\n');
  const route = routeTask(combinedPrompt, config);
  const plannerModelAliases = buildPlannerModelAliasCandidates(config, route.modelAlias);
  let plannerModelIndex = 0;

  const context = await buildContext(
    {
      prompt: combinedPrompt,
      explicitFiles: requestArtifact.explicitFiles,
      pastedSnippets: requestArtifact.pastedSnippets,
    },
    config,
    new PolicyEngine(config, {
      grantedReadPaths: requestArtifact.explicitFiles,
      grantedWritePaths: requestArtifact.explicitFiles,
    }),
  );

  const nextRevision = determineNextRevision(input.prompt, prior);
  const contextPacket = buildContextPacket(combinedPrompt, requestArtifact, context, route.maxSteps, nextRevision, tools);
  let plan = initializePlannerPlan(prior?.plan, nextRevision, contextPacket.objective);
  let state = initializePlannerState(prior?.state, nextRevision, input.prompt, Boolean(prior));
  const transcript: string[] = [];

  await writePlannerArtifacts(session, requestArtifact, context, contextPacket, plan, state);
  await appendPlannerEvent(session, {
    type: prior ? (input.prompt.trim() ? 'planner_replanned' : 'planner_resumed') : 'planner_started',
    revision: nextRevision,
    prompt: input.prompt || '(resume)',
    resumedFrom: requestArtifact.resumedFrom,
  }, config.session.redactSecrets);

  if (prior && !input.prompt.trim() && isTerminalOutcome(prior.state.outcome)) {
    if (prior.state.outcome !== 'RUNNING') {
      return mapPlannerResult(prior.state.outcome, session.dir, prior.state.message);
    }
  }

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
      tools.listDefinitions(),
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
      state.phase = 'PENDING';
      state.currentStepId = null;
      state.consistencyErrors = runPlanConsistencyChecks(plan);
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
    if (state.outcome === 'DONE' && state.consistencyErrors.length > 0) {
      state.outcome = 'FAILED';
      state.message = `Planner consistency check failed: ${state.consistencyErrors.join('; ')}`;
    } else {
      state.message = step.message;
    }

    if (state.outcome === 'DONE' && input.executeSubtasks) {
      if (plan.steps.length === 0) {
        state.outcome = 'FAILED';
        state.message = 'Planner did not produce a structured plan with executable steps.';
      }
    }

    if (state.outcome === 'DONE' && input.executeSubtasks) {
      const executionResult = await executePlannerPlan(config, providers, session, requestArtifact, plan, state);
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

function buildPlannerModelRequest(
  config: AppConfig,
  model: string,
  providerId: string,
  prompt: string,
  context: Awaited<ReturnType<typeof buildContext>>,
  transcript: string[],
  tools: ReturnType<ToolRegistry['listDefinitions']>,
  plan: PlannerPlan,
  state: PlannerState,
  contextPacket: PlannerContextPacket,
  executeSubtasks: boolean,
): ModelRequest {
  const contextText = context.items
    .map((item) => {
      const warning = item.warning ? `Warning: ${item.warning}\n` : '';
      return `File: ${item.path}\nSource: ${item.source}\nReason: ${item.reason}\n${warning}${item.excerpt}`;
    })
    .join('\n\n---\n\n');
  const toolText = tools
    .map((tool) => `- ${tool.name}: ${tool.description} input=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');

  return {
    providerId,
    model,
    systemPrompt: buildPlannerSystemPrompt(config.routing.maxSteps, executeSubtasks),
    messages: [
      {
        role: 'user',
        content: [
          `Planning request:\n${prompt}`,
          executeSubtasks
            ? 'Execution mode: the host will execute code/test/verify steps after you return a valid plan. Return a structured plan first, then a final summary. Do not claim you cannot execute because the host handles execution.'
            : 'Execution mode: read-only planning only.',
          `Available tools:\n${toolText || '(none)'}`,
          context.selectionSummary,
          `Current plan state:\n${JSON.stringify(state, null, 2)}`,
          `Current plan:\n${JSON.stringify(plan, null, 2)}`,
          `Subtask context packet template:\n${JSON.stringify(contextPacket, null, 2)}`,
          `Context:\n${contextText || '(no context selected)'}`,
          transcript.length > 0 ? `Transcript:\n${transcript.join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    stream: false,
    maxOutputTokens: 4000,
    metadata: {
      mode: 'planner-json-loop',
    },
  };
}

function buildPlannerSystemPrompt(maxSteps: number, executeSubtasks: boolean): string {
  return [
    'You are a planning agent operating inside a secure local host.',
    `You may take at most ${maxSteps} steps before the host will stop you.`,
    'This mode is read-only. You must never propose patches or code changes directly.',
    'Valid response types are JSON objects with type = tool_call, plan, plan_update, or final.',
    'Do not output prose outside JSON.',
    'Use read_file, list_files, search_text, and git_diff when you need more information before updating the plan.',
    'Treat pasted snippets such as [Pasted ~6 lines #1] as first-class search clues.',
    'Plan steps must use statuses from: PENDING, SEARCHING, PATCHING, VERIFYING, FAILED, DONE.',
    'Prefer step kinds search, code, test, and verify when they apply, and include relatedFiles whenever you can identify them.',
    'When the user asks for a plan, produce a structured plan with ordered steps, then optionally update step statuses as you search.',
    executeSubtasks
      ? 'The host will execute your code, test, and verify steps after you provide the plan. You must return a real plan object with non-empty steps before the final summary.'
      : 'The host will not execute steps in this mode; produce a read-only plan only.',
    'When you need the user to clarify something, return final with outcome NEEDS_INPUT.',
    'Never return type patch in planner mode.',
    'Plan responses must follow this schema:',
    '{"type":"plan","plan":{"version":"1","summary":"...","steps":[{"id":"step-1","title":"Find router files","status":"PENDING","kind":"search","details":"...","dependencies":[],"children":[]} ]}}',
    'Plan update responses must follow this schema:',
    '{"type":"plan_update","stepId":"step-1","status":"SEARCHING","message":"Searching router files","relatedFiles":["src/router.ts"]}',
    'Final responses must follow this schema:',
    '{"type":"final","outcome":"DONE","message":"Plan complete","summary":"..."}',
  ].join(' ');
}

function parsePlannerResponse(content: string): PlannerResponse {
  const parsed = JSON.parse(extractJsonObject(content)) as Record<string, unknown>;
  const type = parsed.type;

  if (type === 'patch') {
    throw new Error('Planner mode is read-only. Response type patch is forbidden.');
  }

  if (type === 'tool_call') {
    return withOptionalThought(
      {
        type: 'tool_call',
        tool: String(parsed.tool),
        input: (parsed.input as Record<string, unknown>) ?? {},
      },
      parsed.thought,
    );
  }

  if (type === 'plan') {
    const rawPlan = parsed.plan;
    if (!rawPlan || typeof rawPlan !== 'object') {
      throw new Error('Planner response did not contain a valid plan object.');
    }
    return withOptionalThought(
      {
        type: 'plan',
        plan: rawPlan as PlannerPlanPayload,
      },
      parsed.thought,
    );
  }

  if (type === 'plan_update') {
    return withOptionalThought(
      {
        type: 'plan_update',
        stepId: String(parsed.stepId ?? ''),
        status: normalizeStepStatus(parsed.status),
        ...(typeof parsed.message === 'string' ? { message: parsed.message } : {}),
        ...(Array.isArray(parsed.relatedFiles) ? { relatedFiles: parsed.relatedFiles.filter((item): item is string => typeof item === 'string') } : {}),
      },
      parsed.thought,
    );
  }

  if (type === 'final') {
    const outcome = parsed.outcome;
    const normalizedOutcome = outcome === 'FAILED' || outcome === 'DONE' || outcome === 'CANCELLED' || outcome === 'NEEDS_INPUT'
      ? outcome
      : 'DONE';
    return withOptionalThought(
      {
        type: 'final',
        message: String(parsed.message ?? ''),
        outcome: normalizedOutcome,
        ...(typeof parsed.summary === 'string' ? { summary: parsed.summary } : {}),
      },
      parsed.thought,
    );
  }

  throw new Error('Planner response did not contain a valid planner step.');
}

function normalizePlannerPlan(input: PlannerPlanPayload, revision: number, workspaceRoot: string): PlannerPlan {
  const stepsInput = Array.isArray(input.steps) ? input.steps : [];
  const steps = stepsInput.map((step: unknown, index: number) => normalizePlannerStep(step, index, workspaceRoot));
  const plan: PlannerPlan = {
    version: '1',
    revision: typeof input.revision === 'number' ? input.revision : revision,
    summary: String(input.summary ?? ''),
    steps,
  };
  const errors = runPlanConsistencyChecks(plan);
  if (errors.length > 0) {
    throw new Error(`Planner plan is invalid: ${errors.join('; ')}`);
  }
  return plan;
}

function normalizePlannerStep(step: unknown, index: number, workspaceRoot: string): PlannerStep {
  const record = (step && typeof step === 'object' ? step : {}) as Record<string, unknown>;
  return {
    id: String(record.id ?? `step-${index + 1}`),
    title: String(record.title ?? `Step ${index + 1}`),
    status: normalizeStepStatus(record.status),
    kind: normalizeStepKind(record.kind),
    ...(typeof record.details === 'string' ? { details: record.details } : {}),
    ...(Array.isArray(record.relatedFiles)
      ? { relatedFiles: record.relatedFiles.filter((item): item is string => typeof item === 'string').map((item) => normalizePlannerFilePath(workspaceRoot, item)) }
      : {}),
    dependencies: Array.isArray(record.dependencies)
      ? record.dependencies.filter((item): item is string => typeof item === 'string')
      : [],
    children: Array.isArray(record.children)
      ? record.children.filter((item): item is string => typeof item === 'string')
      : [],
    ...(typeof record.assignee === 'string' ? { assignee: record.assignee } : {}),
    ...(record.subtaskContext && typeof record.subtaskContext === 'object'
      ? { subtaskContext: record.subtaskContext as PlannerContextPacket }
      : {}),
  };
}

function normalizeStepKind(kind: unknown): PlannerStep['kind'] {
  return kind === 'search' || kind === 'code' || kind === 'test' || kind === 'verify' || kind === 'docs' || kind === 'note'
    ? kind
    : 'note';
}

function normalizeStepStatus(status: unknown): PlannerStepStatus {
  return status === 'PENDING' || status === 'SEARCHING' || status === 'PATCHING' || status === 'VERIFYING' || status === 'FAILED' || status === 'DONE'
    ? status
    : 'PENDING';
}

function applyPlanUpdate(plan: PlannerPlan, update: Extract<PlannerResponse, { type: 'plan_update' }>): PlannerPlan {
  const stepIndex = plan.steps.findIndex((step) => step.id === update.stepId);
  if (stepIndex < 0) {
    throw new Error(`Planner update referenced unknown step: ${update.stepId}`);
  }

  const current = plan.steps[stepIndex];
  if (!current) {
    throw new Error(`Planner update referenced unknown step: ${update.stepId}`);
  }

  const next: PlannerStep = {
    ...current,
    status: update.status,
    ...(update.message ? { details: update.message } : {}),
    ...(update.relatedFiles ? { relatedFiles: update.relatedFiles } : {}),
  };
  const steps = plan.steps.slice();
  steps[stepIndex] = next;
  return {
    ...plan,
    steps,
  };
}

function runPlanConsistencyChecks(plan: PlannerPlan): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (!step.id) {
      errors.push('Plan step is missing an id.');
      continue;
    }
    if (ids.has(step.id)) {
      errors.push(`Duplicate step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependencies) {
      if (!ids.has(dependency)) {
        errors.push(`Unknown dependency ${dependency} referenced by ${step.id}`);
      }
    }
    for (const child of step.children) {
      if (child.startsWith('subtask-')) {
        continue;
      }
      if (!ids.has(child)) {
        errors.push(`Unknown child ${child} referenced by ${step.id}`);
      }
    }
  }

  return errors;
}

function buildPlannerRequestArtifact(
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

function determineNextRevision(prompt: string, prior: PlannerSessionArtifacts | undefined): number {
  if (!prior) {
    return 1;
  }

  return prompt.trim() ? prior.state.revision + 1 : prior.state.revision;
}

function initializePlannerPlan(prior: PlannerPlan | undefined, revision: number, objective: string): PlannerPlan {
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

function initializePlannerState(prior: PlannerState | undefined, revision: number, prompt: string, resumed: boolean): PlannerState {
  if (prior) {
    return {
      ...prior,
      revision,
      outcome: 'RUNNING',
      phase: 'PENDING',
      currentStepId: null,
      invalidResponseAttempts: 0,
      message: prompt.trim() ? 'Planner replanning with new input.' : 'Planner resumed.',
      consistencyErrors: [],
    };
  }

  return {
    version: '1',
    revision,
    phase: 'PENDING',
    outcome: 'RUNNING',
    currentStepId: null,
    invalidResponseAttempts: 0,
    message: resumed ? 'Planner resumed.' : 'Planner started.',
    consistencyErrors: [],
  };
}

function buildContextPacket(
  prompt: string,
  request: PlannerRequestArtifact,
  context: Awaited<ReturnType<typeof buildContext>>,
  maxSteps: number,
  revision: number,
  tools: ToolRegistry,
): PlannerContextPacket {
  return {
    version: '1',
    objective: prompt,
    request: prompt,
    explicitFiles: request.explicitFiles,
    pastedSnippets: request.pastedSnippets.map((snippet, index) => `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}] ${snippet}`),
    queryTerms: context.queryTerms,
    contextItems: context.items.map((item) => ({
      path: item.path,
      source: item.source,
      reason: item.reason,
    })),
    constraints: {
      readOnly: true,
      allowedTools: tools.listDefinitions().map((tool) => tool.name),
      maxSteps,
    },
    planRevision: revision,
  };
}

async function writePlannerArtifacts(
  session: SessionRecord,
  request: PlannerRequestArtifact,
  context: Awaited<ReturnType<typeof buildContext>>,
  contextPacket: PlannerContextPacket,
  plan: PlannerPlan,
  state: PlannerState,
): Promise<void> {
  await writeSessionArtifact(session, 'planner.request.json', JSON.stringify(request, null, 2));
  await writeSessionArtifact(session, 'planner.context.json', JSON.stringify(context, null, 2));
  await writeSessionArtifact(session, 'planner.context.packet.json', JSON.stringify(contextPacket, null, 2));
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(plan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
}

async function appendPlannerEvent(
  session: SessionRecord,
  event: Record<string, unknown>,
  redactSecrets: boolean,
): Promise<void> {
  await appendSessionLog(session, 'plan.events.jsonl', event, redactSecrets);
}

async function appendPlannerStructuredLog(
  session: SessionRecord,
  record: Record<string, unknown>,
  redactSecrets: boolean,
): Promise<void> {
  await appendSessionLog(session, 'planner.log.jsonl', record, redactSecrets);
}

async function resumePlannerSession(
  config: AppConfig,
  sessionRef: string | undefined,
  useLatest: boolean | undefined,
): Promise<SessionRecord> {
  const dir = await resolveSessionDir(config, sessionRef, useLatest);
  return {
    id: path.basename(dir),
    dir,
  };
}

async function loadPlannerSessionArtifacts(sessionDir: string): Promise<PlannerSessionArtifacts> {
  const [requestRaw, planRaw, stateRaw] = await Promise.all([
    readFile(path.join(sessionDir, 'planner.request.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.state.json'), 'utf8'),
  ]);

  return {
    request: JSON.parse(requestRaw) as PlannerRequestArtifact,
    plan: JSON.parse(planRaw) as PlannerPlan,
    state: JSON.parse(stateRaw) as PlannerState,
  };
}

function statusToPhase(status: PlannerStepStatus): PlannerPhase {
  if (status === 'SEARCHING') {
    return 'SEARCHING';
  }
  if (status === 'PATCHING') {
    return 'PATCHING';
  }
  if (status === 'VERIFYING') {
    return 'VERIFYING';
  }
  return 'PENDING';
}

function isTerminalOutcome(outcome: PlannerOutcome): boolean {
  return outcome === 'DONE' || outcome === 'FAILED' || outcome === 'CANCELLED' || outcome === 'NEEDS_INPUT';
}

function mapPlannerResult(outcome: Exclude<PlannerOutcome, 'RUNNING'>, sessionDir: string, message: string): RunPlannerResult {
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

async function executePlannerPlan(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
): Promise<{ plan: PlannerPlan; state: PlannerState }> {
  const accumulatedChangedFiles = new Set<string>();
  let nextPlan = plan;
  let nextState = {
    ...state,
    message: 'Planner finished planning. Starting serial subtask execution.',
  };

  await appendPlannerEvent(session, { type: 'planner_execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await appendPlannerStructuredLog(session, { type: 'execution_started', revision: nextPlan.revision }, config.session.redactSecrets);

  for (const step of nextPlan.steps) {
    if (step.dependencies.some((dependency) => nextPlan.steps.find((candidate) => candidate.id === dependency)?.status !== 'DONE')) {
      nextPlan = updatePlannerStep(nextPlan, step.id, {
        status: 'FAILED',
        details: `Blocked by unmet dependencies: ${step.dependencies.join(', ')}`,
      });
      nextState = {
        ...nextState,
        outcome: 'FAILED',
        currentStepId: step.id,
        message: `Planner execution blocked by unmet dependencies for ${step.id}.`,
      };
      await appendPlannerEvent(session, { type: 'subtask_failed', stepId: step.id, reason: nextState.message }, config.session.redactSecrets);
      return { plan: nextPlan, state: nextState };
    }

    const executionMode = classifyPlannerStep(step);
    if (executionMode === 'skip') {
      nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'DONE' });
      await appendPlannerEvent(session, { type: 'subtask_skipped', stepId: step.id, kind: step.kind, reason: 'Planning-only step' }, config.session.redactSecrets);
      continue;
    }

    if (executionMode === 'verify') {
      nextState = {
        ...nextState,
        phase: 'VERIFYING',
        currentStepId: step.id,
        message: `Running final verifier for ${step.title}`,
      };
      nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'VERIFYING' });
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await appendPlannerEvent(session, { type: 'subtask_started', stepId: step.id, executor: 'verifier', title: step.title }, config.session.redactSecrets);

      const verifyResult = await runVerifier(config, new PolicyEngine(config), {
        changedFiles: [...accumulatedChangedFiles],
        providers,
      });
      await writeSessionArtifact(session, `subtask.${step.id}.verify.json`, JSON.stringify(verifyResult, null, 2));

      if (verifyResult.success) {
        nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'DONE' });
        await appendPlannerEvent(session, {
          type: 'subtask_completed',
          stepId: step.id,
          executor: 'verifier',
          success: true,
          changedFiles: [...accumulatedChangedFiles],
        }, config.session.redactSecrets);
        continue;
      }

      await appendPlannerEvent(session, {
        type: 'subtask_verify_failed',
        stepId: step.id,
        executor: 'verifier',
        failures: verifyResult.failures.map((failure) => ({ command: failure.command, stderr: failure.stderr })),
      }, config.session.redactSecrets);

      const repairPrompt = buildVerifyRepairPrompt(requestArtifact, nextPlan, verifyResult);
      const repairResult = await executeSubtaskAgent(config, providers, repairPrompt, [...accumulatedChangedFiles], true);
      await writeSessionArtifact(session, `subtask.${step.id}.repair.json`, JSON.stringify(repairResult, null, 2));
      await appendPlannerEvent(session, {
        type: repairResult.status === 'completed' ? 'subtask_completed' : 'subtask_failed',
        stepId: step.id,
        executor: 'coder',
        modelAlias: repairResult.modelAlias,
        sessionDir: repairResult.sessionDir,
        changedFiles: repairResult.changedFiles,
        message: repairResult.message,
      }, config.session.redactSecrets);

      if (repairResult.status !== 'completed') {
        nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'FAILED', details: repairResult.message });
        nextState = {
          ...nextState,
          outcome: 'FAILED',
          message: repairResult.message,
          currentStepId: step.id,
        };
        return { plan: nextPlan, state: nextState };
      }

      for (const file of repairResult.changedFiles) {
        accumulatedChangedFiles.add(file);
      }

      nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'DONE', relatedFiles: [...accumulatedChangedFiles] });
      continue;
    }

    nextState = {
      ...nextState,
      phase: 'PATCHING',
      currentStepId: step.id,
      message: `Executing subtask ${step.title}`,
    };
    const subtaskId = `subtask-${step.id}`;
    nextPlan = updatePlannerStep(nextPlan, step.id, {
      status: 'PATCHING',
      assignee: 'subagent',
      children: step.children.includes(subtaskId) ? step.children : [...step.children, subtaskId],
      subtaskContext: buildStepContextPacket(requestArtifact, nextPlan, step),
    });
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
    await appendPlannerEvent(session, {
      type: 'subtask_started',
      stepId: step.id,
      executor: 'coder',
      modelAlias: config.routing.codeModel,
      title: step.title,
      explicitFiles: step.relatedFiles ?? requestArtifact.explicitFiles,
    }, config.session.redactSecrets);

    const subtaskPrompt = buildSubtaskPrompt(requestArtifact, nextPlan, step);
    const subtaskResult = await executeSubtaskAgent(config, providers, subtaskPrompt, step.relatedFiles ?? requestArtifact.explicitFiles, false);
    await writeSessionArtifact(session, `subtask.${step.id}.json`, JSON.stringify(subtaskResult, null, 2));
    await appendPlannerEvent(session, {
      type: subtaskResult.status === 'completed' ? 'subtask_completed' : 'subtask_failed',
      stepId: step.id,
      executor: 'coder',
      modelAlias: subtaskResult.modelAlias,
      sessionDir: subtaskResult.sessionDir,
      changedFiles: subtaskResult.changedFiles,
      message: subtaskResult.message,
    }, config.session.redactSecrets);

    if (subtaskResult.status !== 'completed') {
      nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'FAILED', details: subtaskResult.message });
      nextState = {
        ...nextState,
        outcome: 'FAILED',
        currentStepId: step.id,
        message: subtaskResult.message,
      };
      return { plan: nextPlan, state: nextState };
    }

    for (const file of subtaskResult.changedFiles) {
      accumulatedChangedFiles.add(file);
    }

    nextPlan = updatePlannerStep(nextPlan, step.id, {
      status: 'DONE',
      relatedFiles: mergeStringLists(step.relatedFiles ?? [], subtaskResult.changedFiles),
    });
  }

  nextState = {
    ...nextState,
    phase: 'PENDING',
    outcome: 'DONE',
    currentStepId: null,
    message: 'Planner executed all subtasks and verifier passed.',
    consistencyErrors: runPlanConsistencyChecks(nextPlan),
  };

  await appendPlannerEvent(session, { type: 'planner_execution_finished', outcome: nextState.outcome }, config.session.redactSecrets);
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  return { plan: nextPlan, state: nextState };
}

async function executeSubtaskAgent(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  prompt: string,
  explicitFiles: string[],
  enableVerifier: boolean,
): Promise<Awaited<ReturnType<typeof runAgent>>> {
  const subtaskConfig = enableVerifier ? config : {
    ...config,
    verifier: {
      ...config.verifier,
      enabled: false,
      allowDiscovery: false,
      commands: [],
    },
  };
  const policy = new PolicyEngine(subtaskConfig);
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(subtaskConfig, policy)) {
    registry.register(tool);
  }

  return runAgent(subtaskConfig, providers, registry, {
    prompt,
    explicitFiles,
    pastedSnippets: [],
    manualVerifierCommands: [],
    autoApprove: true,
    confirm: async () => true,
    routeOverride: {
      modelAlias: config.routing.codeModel,
      intent: 'code',
      maxSteps: config.routing.maxSteps,
      maxAutoRepairAttempts: enableVerifier ? config.routing.maxAutoRepairAttempts : 0,
    },
  });
}

function classifyPlannerStep(step: PlannerStep): 'skip' | 'subagent' | 'verify' {
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

function updatePlannerStep(
  plan: PlannerPlan,
  stepId: string,
  updates: Partial<PlannerStep>,
): PlannerPlan {
  return {
    ...plan,
    steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
  };
}

function buildSubtaskPrompt(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  step: PlannerStep,
): string {
  return [
    `Original objective: ${requestArtifact.promptHistory[0] ?? ''}`,
    `Planner summary: ${plan.summary}`,
    `Execute planner step: ${step.title}`,
    step.details ? `Step details: ${step.details}` : '',
    step.relatedFiles && step.relatedFiles.length > 0 ? `Target files: ${step.relatedFiles.join(', ')}` : '',
    'Make the required code, test, or docs changes for this step only. Keep the change minimal and concrete.',
  ].filter(Boolean).join('\n');
}

function buildVerifyRepairPrompt(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  verifyResult: Awaited<ReturnType<typeof runVerifier>>,
): string {
  return [
    `Original objective: ${requestArtifact.promptHistory[0] ?? ''}`,
    `Planner summary: ${plan.summary}`,
    'Fix the remaining issues so verification passes.',
    `Verifier failures: ${JSON.stringify(verifyResult.failures, null, 2)}`,
    verifyResult.analysis ? `Verifier analysis: ${JSON.stringify(verifyResult.analysis, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
}

function buildStepContextPacket(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  step: PlannerStep,
): PlannerContextPacket {
  return {
    version: '1',
    objective: step.title,
    request: requestArtifact.promptHistory.at(-1) ?? requestArtifact.promptHistory[0] ?? step.title,
    explicitFiles: step.relatedFiles ?? requestArtifact.explicitFiles,
    pastedSnippets: requestArtifact.pastedSnippets.map((snippet, index) => `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}] ${snippet}`),
    queryTerms: extractWordsForStep(step),
    contextItems: (step.relatedFiles ?? requestArtifact.explicitFiles).map((file) => ({
      path: file,
      source: 'planner-step',
      reason: step.title,
    })),
    constraints: {
      readOnly: false,
      allowedTools: ['read_file', 'list_files', 'search_text', 'run_shell', 'git_diff'],
      maxSteps: plan.steps.length + 4,
    },
    planRevision: plan.revision,
    parentStepId: step.id,
  };
}

function extractWordsForStep(step: PlannerStep): string[] {
  return [...new Set(`${step.title} ${step.details ?? ''}`.match(/[a-zA-Z0-9_\u4e00-\u9fff]{2,}/g) ?? [])].slice(0, 12);
}

function mergeStringLists(left: string[], right: string[]): string[] {
  return [...new Set([...left, ...right])];
}

function normalizePlannerFilePath(workspaceRoot: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
  const directCandidate = path.resolve(workspaceRoot, normalized);
  if (existsSync(directCandidate)) {
    return normalized;
  }

  const anchors = ['src/', 'tests/', '.marblecode/', 'package.json'];
  for (const anchor of anchors) {
    const index = normalized.indexOf(anchor);
    if (index < 0) {
      continue;
    }

    const suffix = normalized.slice(index);
    if (existsSync(path.resolve(workspaceRoot, suffix))) {
      return suffix;
    }
  }

  return normalized;
}

function buildPlannerModelAliasCandidates(config: AppConfig, primaryAlias: string): string[] {
  return [...new Set([primaryAlias, config.routing.defaultModel])].filter(Boolean);
}

function shouldFallbackPlannerModel(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return /access forbidden|forbidden|model not found|unsupported model|permission|not authorized|upstream_error/.test(message);
}

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return extractParsableJsonObject(fencedMatch[1].trim());
  }

  return extractParsableJsonObject(trimmed);
}

function extractParsableJsonObject(content: string): string {
  const balanced = extractFirstBalancedJsonObject(content);
  if (isParsableJson(balanced)) {
    return balanced;
  }

  const start = content.indexOf('{');
  if (start < 0) {
    return content;
  }

  for (let index = start; index < content.length; index += 1) {
    if (content[index] !== '}') {
      continue;
    }

    const candidate = content.slice(start, index + 1);
    if (isParsableJson(candidate)) {
      return candidate;
    }
  }

  return balanced;
}

function extractFirstBalancedJsonObject(content: string): string {
  const start = content.indexOf('{');
  if (start < 0) {
    return content;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return content.slice(start);
}

function isParsableJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function withOptionalThought<T extends PlannerResponse>(step: T, thought: unknown): T {
  if (typeof thought === 'string') {
    return {
      ...step,
      thought,
    };
  }

  return step;
}

function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
}

function buildPlannerProviderFailureMessage(error: unknown, retryAttempts: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Planner model request failed after ${retryAttempts} retries. ${reason}`;
}
