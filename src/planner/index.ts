import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import {
  buildExecutionGraph as buildPlannerExecutionGraph,
  derivePlannerAccessMode,
  derivePlannerFileScope,
  getBlockedReasons,
  getReadyStepIds,
} from './graph.js';
import {
  createExecutionLockTable,
  downgradeToGuardedRead,
  type ExecutionLockTable,
} from './locks.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { invokeWithRetry } from '../provider/retry.js';
import { routeTask } from '../router/index.js';
import { appendSessionLog, createSession, writeSessionArtifact, type SessionRecord } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  appendPlannerEvent,
  appendPlannerStructuredLog,
  buildContextPacket,
  loadPlannerSessionArtifacts,
  resumePlannerSession,
  writePlannerArtifacts,
  writePlannerExecutionArtifacts,
} from './artifacts.js';
import type {
  PlannerOutcome,
  PlannerPlan,
  PlannerRequestArtifact,
  PlannerResponse,
  PlannerSessionArtifacts,
  PlannerState,
  PlannerStep,
} from './types.js';
import { buildPlannerModelRequest } from './model.js';
import { applyPlanUpdate, normalizePlannerPlan, parsePlannerResponse, runPlanConsistencyChecks } from './parse.js';
import { buildStepContextPacket, buildSubtaskPrompt } from './prompts.js';
import { attemptPlannerNodeReplan } from './recovery.js';
import { refreshPlannerStateFromPlan, statusToPhase } from './state.js';
import {
  buildPlannerModelAliasCandidates,
  deriveFailureKind,
  mergeStringLists,
  resolveSubtaskFallbackModel,
  shouldFallbackPlannerModel,
} from './utils.js';
import {
  annotateBlockedDependents,
  detectPendingConflictFailure,
  mergePlannerStepResult,
  selectExecutionWave,
} from './execute-wave.js';
import { executePlannerVerifyStep } from './execute-verify.js';
import {
  executeSubtaskAgent,
  prepareLockTableForStep,
  preparePlannerSubtaskAttempt,
  type SubtaskExecutionOutcome,
} from './execute-subtask.js';

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
  const toolDefinitions = tools.listDefinitions();
  const contextPacket = buildContextPacket(combinedPrompt, requestArtifact, context, route.maxSteps, nextRevision, toolDefinitions);
  let plan = initializePlannerPlan(prior?.plan, nextRevision, contextPacket.objective);
  let state = refreshPlannerStateFromPlan(plan, initializePlannerState(prior?.state, nextRevision, input.prompt, Boolean(prior)));
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
    return refreshPlannerStateFromPlan(prior.revision === revision ? undefined : undefined, {
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
  let executionGraph = buildPlannerExecutionGraph(nextPlan, config.routing.subtaskConflictPolicy);
  let lockTable = createExecutionLockTable(nextPlan.revision);
  let nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...state,
    phase: 'PATCHING',
    message: 'Planner finished planning. Starting subtask execution.',
  });

  await appendPlannerEvent(session, { type: 'planner_execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await appendPlannerStructuredLog(session, { type: 'execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);

  while (true) {
    executionGraph = buildPlannerExecutionGraph(nextPlan, config.routing.subtaskConflictPolicy);
    nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
    if (config.routing.subtaskConflictPolicy === 'fail') {
      const conflictError = detectPendingConflictFailure(nextPlan, executionGraph);
      if (conflictError) {
        nextState = {
          ...nextState,
          outcome: 'FAILED',
          phase: 'BLOCKED',
          message: conflictError,
        };
        await appendPlannerEvent(session, { type: 'subtask_conflict_detected', reason: conflictError }, config.session.redactSecrets);
        await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
        await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
        await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
        return { plan: nextPlan, state: nextState };
      }
    }

    const readySteps = getReadyStepIds(nextPlan, nextState, executionGraph)
      .map((stepId) => nextPlan.steps.find((step) => step.id === stepId))
      .filter((step): step is PlannerStep => Boolean(step));
    const pendingSteps = nextPlan.steps.filter((step) => step.status !== 'DONE' && step.status !== 'FAILED');
    if (pendingSteps.length === 0) {
      break;
    }
    if (readySteps.length === 0) {
      const blockedStep = pendingSteps[0];
      if (!blockedStep) {
        break;
      }
      nextPlan = updatePlannerStep(nextPlan, blockedStep.id, {
        status: 'FAILED',
        executionState: 'failed',
        failureKind: 'dependency',
        lastError: `Blocked by unmet dependencies: ${blockedStep.dependencies.join(', ')}`,
        details: `Blocked by unmet dependencies: ${blockedStep.dependencies.join(', ')}`,
      });
      nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...nextState,
        phase: 'BLOCKED',
        outcome: 'FAILED',
        currentStepId: blockedStep.id,
        message: `Planner execution blocked by unmet dependencies for ${blockedStep.id}.`,
      });
      await appendPlannerEvent(session, { type: 'subtask_blocked', stepId: blockedStep.id, reason: nextState.message }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      return { plan: nextPlan, state: nextState };
    }

    const selectedWave = selectExecutionWave(readySteps, executionGraph, config.routing.maxConcurrentSubtasks, classifyPlannerStep);
    if (selectedWave.length === 0) {
      break;
    }
    const skippable = selectedWave.filter((step) => classifyPlannerStep(step) === 'skip');
    if (skippable.length === selectedWave.length) {
      for (const step of skippable) {
        nextPlan = updatePlannerStep(nextPlan, step.id, { status: 'DONE', executionState: 'done' });
        await appendPlannerEvent(session, { type: 'subtask_skipped', stepId: step.id, kind: step.kind, reason: 'Planning-only step' }, config.session.redactSecrets);
      }
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      continue;
    }
    if (selectedWave.length === 1 && classifyPlannerStep(selectedWave[0] ?? nextPlan.steps[0] ?? { kind: 'note', title: '', details: '' } as PlannerStep) === 'verify') {
      const step = selectedWave[0];
      if (!step) {
        break;
      }
      const verifyResult = await executePlannerVerifyStep(
        config,
        providers,
        session,
        requestArtifact,
        nextPlan,
        nextState,
        step,
        [...accumulatedChangedFiles],
        lockTable,
        {
          executePlannerSubtaskWithRecovery,
          updatePlannerStep,
        },
      );
      nextPlan = verifyResult.plan;
      nextState = verifyResult.state;
      lockTable = verifyResult.lockTable;
      for (const file of verifyResult.changedFiles) {
        accumulatedChangedFiles.add(file);
      }
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      if (verifyResult.stop) {
        return { plan: nextPlan, state: nextState };
      }
      continue;
    }

    const waveResult = await executePlannerWave(
      config,
      providers,
      session,
      requestArtifact,
      nextPlan,
      nextState,
      selectedWave,
      lockTable,
    );
    nextPlan = waveResult.plan;
    nextState = waveResult.state;
    lockTable = waveResult.lockTable;
    for (const file of waveResult.changedFiles) {
      accumulatedChangedFiles.add(file);
    }
    if (waveResult.replanned) {
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      continue;
    }
    if (waveResult.stop) {
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      return { plan: nextPlan, state: nextState };
    }
    await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
  }

  nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...nextState,
    phase: 'PENDING',
    outcome: 'DONE',
    currentStepId: null,
    message: 'Planner executed all subtasks and verifier passed.',
    consistencyErrors: runPlanConsistencyChecks(nextPlan),
  });

  await appendPlannerEvent(session, { type: 'planner_execution_finished', outcome: nextState.outcome }, config.session.redactSecrets);
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
  return { plan: nextPlan, state: nextState };
}

async function executePlannerWave(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  wave: PlannerStep[],
  lockTable: ExecutionLockTable,
): Promise<{ plan: PlannerPlan; state: PlannerState; changedFiles: string[]; stop: boolean; replanned: boolean; lockTable: ExecutionLockTable }> {
  let nextPlan = plan;
  let nextState = state;
  let nextLockTable = lockTable;
  const changedFiles = new Set<string>();
  const concurrent = wave.length > 1;

  for (const step of wave) {
    const fileScope = derivePlannerFileScope(step).length > 0 ? derivePlannerFileScope(step) : (step.relatedFiles ?? requestArtifact.explicitFiles);
    nextLockTable = prepareLockTableForStep(nextLockTable, nextPlan, step, fileScope);
  }

  await appendPlannerEvent(session, {
    type: 'planner_wave_started',
    wave: wave.map((step) => step.id),
    concurrent,
  }, config.session.redactSecrets);

  const results = await Promise.allSettled(
    wave.map(async (step) => {
      const fileScope = derivePlannerFileScope(step).length > 0 ? derivePlannerFileScope(step) : (step.relatedFiles ?? requestArtifact.explicitFiles);
      const subtaskPrompt = buildSubtaskPrompt(requestArtifact, nextPlan, step);
      return executePlannerSubtaskWithRecovery(
        config,
        providers,
        session,
        requestArtifact,
        nextPlan,
        nextState,
        step,
        subtaskPrompt,
        fileScope,
        false,
        wave.length === 1,
        nextLockTable,
        false,
      );
    }),
  );

  let stop = false;
  let replanned = false;
  const failedStepIds = new Set<string>();
  for (let index = 0; index < results.length; index += 1) {
    const settled = results[index];
    const step = wave[index];
    if (!step) {
      continue;
    }
    if (!settled || settled.status === 'rejected') {
      const message = settled?.status === 'rejected'
        ? (settled.reason instanceof Error ? settled.reason.message : String(settled.reason))
        : `Planner wave failed for ${step.id}`;
      nextPlan = updatePlannerStep(nextPlan, step.id, {
        status: 'FAILED',
        executionState: 'failed',
        failureKind: 'model',
        lastError: message,
        details: message,
      });
      nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...nextState,
        outcome: 'FAILED',
        currentStepId: step.id,
        message,
      });
      failedStepIds.add(step.id);
      stop = true;
      continue;
    }

    const value = settled.value;
    nextPlan = mergePlannerStepResult(nextPlan, value.plan, step.id, updatePlannerStep);
    nextState = refreshPlannerStateFromPlan(nextPlan, {
      ...nextState,
      phase: value.state.phase,
      currentStepId: value.state.currentStepId,
      message: value.state.message,
      outcome: value.state.outcome,
      consistencyErrors: value.state.consistencyErrors,
      ...(value.state.lastReplanReason ? { lastReplanReason: value.state.lastReplanReason } : {}),
    });
    const lockedFiles = value.changedFiles.length > 0 ? value.changedFiles : derivePlannerFileScope(step);
    if (!value.stop && !value.replanned && lockedFiles.length > 0) {
      nextLockTable = downgradeToGuardedRead(nextLockTable, step.id, lockedFiles, nextPlan.revision);
    }
    for (const file of value.changedFiles) {
      changedFiles.add(file);
    }
    if (value.stop) {
      failedStepIds.add(step.id);
    }
    stop ||= value.stop;
    replanned ||= value.replanned;
  }

  if (stop && !replanned && failedStepIds.size > 0) {
    nextPlan = annotateBlockedDependents(nextPlan, failedStepIds, updatePlannerStep);
    nextState = refreshPlannerStateFromPlan(nextPlan, {
      ...nextState,
      outcome: 'FAILED',
      message: nextState.message || `Planner execution stopped after failures in ${[...failedStepIds].join(', ')}.`,
    });
  }

  await appendPlannerEvent(session, {
    type: 'planner_wave_finished',
    wave: wave.map((step) => step.id),
    concurrent,
    stop,
    replanned,
  }, config.session.redactSecrets);

  return {
    plan: nextPlan,
    state: nextState,
    changedFiles: [...changedFiles],
    stop,
    replanned,
    lockTable: nextLockTable,
  };
}

async function executePlannerSubtaskWithRecovery(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  step: PlannerStep,
  prompt: string,
  explicitFiles: string[],
  enableVerifier: boolean,
  allowReplan: boolean,
  lockTable: ExecutionLockTable,
  manageLocksInternally: boolean,
): Promise<{ plan: PlannerPlan; state: PlannerState; changedFiles: string[]; stop: boolean; replanned: boolean; lockTable: ExecutionLockTable }> {
  let nextPlan = plan;
  let nextState = state;
  const maxAttempts = step.maxAttempts ?? config.routing.subtaskMaxAttempts;
  const effectiveFileScope = [...new Set([...derivePlannerFileScope(step), ...explicitFiles])];
  let latestFailure: SubtaskExecutionOutcome | null = null;

  for (let attempt = step.attempts + 1; attempt <= maxAttempts; attempt += 1) {
    const phase = attempt > 1 ? 'RETRYING' : 'PATCHING';
    const executionState = attempt > 1 ? 'retrying' : 'running';
    const label = attempt > 1 ? `Retrying subtask ${step.title}` : `Executing subtask ${step.title}`;
    const update = preparePlannerSubtaskAttempt(nextPlan, requestArtifact, step.id, attempt, executionState, explicitFiles, updatePlannerStep);
    nextPlan = update.plan;
    if (manageLocksInternally) {
      lockTable = prepareLockTableForStep(lockTable, nextPlan, step, effectiveFileScope);
    }
    nextState = refreshPlannerStateFromPlan(nextPlan, {
      ...nextState,
      phase,
      currentStepId: step.id,
      message: label,
    });
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
    await appendPlannerEvent(session, {
      type: attempt > 1 ? 'subtask_retry_started' : 'subtask_started',
      stepId: step.id,
      executor: 'coder',
      modelAlias: config.routing.codeModel,
      attempt,
      title: step.title,
      explicitFiles: effectiveFileScope,
    }, config.session.redactSecrets);
    if (manageLocksInternally && effectiveFileScope.length > 0) {
      await appendPlannerEvent(session, {
        type: 'subtask_lock_acquired',
        stepId: step.id,
        files: effectiveFileScope,
      }, config.session.redactSecrets);
    }

    const outcome = await executeSubtaskAgent(config, providers, prompt, effectiveFileScope, enableVerifier, config.routing.codeModel, attempt, false, step.id, lockTable);
    await writeSessionArtifact(session, `subtask.${step.id}.attempt-${attempt}.json`, JSON.stringify(outcome.result, null, 2));
    await writeSessionArtifact(session, `subtask.${step.id}.json`, JSON.stringify(outcome.result, null, 2));
    if (outcome.result.status === 'completed') {
      const lockedFiles = outcome.result.changedFiles.length > 0 ? outcome.result.changedFiles : effectiveFileScope;
      if (manageLocksInternally) {
        lockTable = downgradeToGuardedRead(lockTable, step.id, lockedFiles, nextPlan.revision);
      }
      nextPlan = updatePlannerStep(nextPlan, step.id, {
        status: 'DONE',
        attempts: attempt,
        executionState: 'done',
        relatedFiles: mergeStringLists(step.relatedFiles ?? [], outcome.result.changedFiles),
        producesFiles: mergeStringLists(step.producesFiles ?? [], outcome.result.changedFiles),
        fileScope: mergeStringLists(step.fileScope ?? [], lockedFiles),
        lastError: '',
      });
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await appendPlannerEvent(session, {
        type: 'subtask_completed',
        stepId: step.id,
        executor: 'coder',
        modelAlias: outcome.modelAlias,
        sessionDir: outcome.result.sessionDir,
        changedFiles: outcome.result.changedFiles,
        message: outcome.result.message,
        attempt,
      }, config.session.redactSecrets);
      if (manageLocksInternally && lockedFiles.length > 0) {
        await appendPlannerEvent(session, {
          type: 'subtask_lock_downgraded',
          stepId: step.id,
          files: lockedFiles,
        }, config.session.redactSecrets);
      }
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      return { plan: nextPlan, state: nextState, changedFiles: outcome.result.changedFiles, stop: false, replanned: false, lockTable };
    }

    latestFailure = outcome;
    nextPlan = updatePlannerStep(nextPlan, step.id, {
      status: 'PENDING',
      attempts: attempt,
      executionState: attempt < maxAttempts ? 'retrying' : 'idle',
      lastError: outcome.result.message,
      failureKind: deriveFailureKind(outcome.result.message),
      details: outcome.result.message,
    });
    nextState = refreshPlannerStateFromPlan(nextPlan, {
      ...nextState,
      phase: attempt < maxAttempts ? 'RETRYING' : nextState.phase,
      currentStepId: step.id,
      message: outcome.result.message,
    });
    if (attempt < maxAttempts) {
      await appendPlannerEvent(session, {
        type: 'subtask_retry_scheduled',
        stepId: step.id,
        attempt,
        maxAttempts,
        reason: outcome.result.message,
      }, config.session.redactSecrets);
    }
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  }

  const fallbackModel = resolveSubtaskFallbackModel(config, config.routing.codeModel);
  if (fallbackModel && latestFailure) {
    if (manageLocksInternally) {
      lockTable = prepareLockTableForStep(lockTable, nextPlan, step, effectiveFileScope);
    }
    nextPlan = preparePlannerSubtaskAttempt(nextPlan, requestArtifact, step.id, step.attempts + maxAttempts + 1, 'fallback', explicitFiles, updatePlannerStep).plan;
    nextState = refreshPlannerStateFromPlan(nextPlan, {
      ...nextState,
      phase: 'RETRYING',
      currentStepId: step.id,
      message: `Falling back to model ${fallbackModel} for ${step.title}`,
    });
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
    await appendPlannerEvent(session, {
      type: 'subtask_fallback_started',
      stepId: step.id,
      fromModelAlias: config.routing.codeModel,
      toModelAlias: fallbackModel,
      reason: latestFailure.result.message,
    }, config.session.redactSecrets);
    if (manageLocksInternally && effectiveFileScope.length > 0) {
      await appendPlannerEvent(session, {
        type: 'subtask_lock_transferred',
        stepId: step.id,
        files: effectiveFileScope,
        fromStepId: latestFailure.result.sessionDir ? step.id : step.id,
      }, config.session.redactSecrets);
    }

    const fallbackOutcome = await executeSubtaskAgent(config, providers, prompt, effectiveFileScope, enableVerifier, fallbackModel, step.attempts + maxAttempts + 1, true, step.id, lockTable);
    await writeSessionArtifact(session, `subtask.${step.id}.fallback.json`, JSON.stringify(fallbackOutcome.result, null, 2));
    if (fallbackOutcome.result.status === 'completed') {
      const lockedFiles = fallbackOutcome.result.changedFiles.length > 0 ? fallbackOutcome.result.changedFiles : effectiveFileScope;
      if (manageLocksInternally) {
        lockTable = downgradeToGuardedRead(lockTable, step.id, lockedFiles, nextPlan.revision);
      }
      nextPlan = updatePlannerStep(nextPlan, step.id, {
        status: 'DONE',
        attempts: step.attempts + maxAttempts + 1,
        executionState: 'done',
        relatedFiles: mergeStringLists(step.relatedFiles ?? [], fallbackOutcome.result.changedFiles),
        producesFiles: mergeStringLists(step.producesFiles ?? [], fallbackOutcome.result.changedFiles),
        fileScope: mergeStringLists(step.fileScope ?? [], lockedFiles),
      });
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await appendPlannerEvent(session, {
        type: 'subtask_completed',
        stepId: step.id,
        executor: 'coder',
        modelAlias: fallbackOutcome.modelAlias,
        sessionDir: fallbackOutcome.result.sessionDir,
        changedFiles: fallbackOutcome.result.changedFiles,
        message: fallbackOutcome.result.message,
        attempt: step.attempts + maxAttempts + 1,
      }, config.session.redactSecrets);
      if (manageLocksInternally && lockedFiles.length > 0) {
        await appendPlannerEvent(session, {
          type: 'subtask_lock_downgraded',
          stepId: step.id,
          files: lockedFiles,
        }, config.session.redactSecrets);
      }
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      return { plan: nextPlan, state: nextState, changedFiles: fallbackOutcome.result.changedFiles, stop: false, replanned: false, lockTable };
    }
    latestFailure = fallbackOutcome;
    nextPlan = updatePlannerStep(nextPlan, step.id, {
      status: 'PENDING',
      attempts: step.attempts + maxAttempts + 1,
      executionState: 'idle',
      lastError: fallbackOutcome.result.message,
      failureKind: deriveFailureKind(fallbackOutcome.result.message),
      details: fallbackOutcome.result.message,
    });
    nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  }

  if (allowReplan && config.routing.subtaskReplanOnFailure && latestFailure) {
    const replanned = await attemptPlannerNodeReplan(config, providers, session, requestArtifact, nextPlan, nextState, step.id, latestFailure.result.message);
    if (replanned) {
      return { plan: replanned.plan, state: replanned.state, changedFiles: [], stop: false, replanned: true, lockTable };
    }
  }

  const failureMessage = latestFailure?.result.message ?? `Subtask ${step.id} failed.`;
  nextPlan = updatePlannerStep(nextPlan, step.id, {
    status: 'FAILED',
    executionState: 'failed',
    lastError: failureMessage,
    failureKind: deriveFailureKind(failureMessage),
    details: failureMessage,
  });
  nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...nextState,
    outcome: 'FAILED',
    currentStepId: step.id,
    message: failureMessage,
  });
  await appendPlannerEvent(session, {
    type: 'subtask_failed',
    stepId: step.id,
    executor: 'coder',
    modelAlias: latestFailure?.modelAlias ?? config.routing.codeModel,
    sessionDir: latestFailure?.result.sessionDir ?? '',
    changedFiles: latestFailure?.result.changedFiles ?? [],
    message: failureMessage,
  }, config.session.redactSecrets);
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  return { plan: nextPlan, state: nextState, changedFiles: latestFailure?.result.changedFiles ?? [], stop: true, replanned: false, lockTable };
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

function buildPlannerProviderFailureMessage(error: unknown, retryAttempts: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Planner model request failed after ${retryAttempts} retries. ${reason}`;
}
