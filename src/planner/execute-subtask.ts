import path from 'node:path';
import { runAgent } from '../agent/index.js';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import { createBuiltinToolProvider } from '../tools/builtins.js';
import { ToolRegistry } from '../tools/registry.js';
import { derivePlannerAccessMode } from './graph.js';
import {
  acquireWriteLocks,
  assertStepCanWrite,
  downgradeToGuardedRead,
  transferWriteOwnership,
  type ExecutionLockTable,
} from './locks.js';
import { canTransferOwnership } from './ownership.js';
import { buildStepContextPacket } from './prompts.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerExecutionFeedbackArtifact, PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep, PlannerStepExecutionState } from './types.js';
import { appendPlannerEvent } from './artifacts.js';
import { attemptPlannerNodeReplan } from './recovery.js';
import { deriveFailureKind, mergeStringLists, resolveSubtaskFallbackModel } from './utils.js';

export interface SubtaskExecutionOutcome {
  result: Awaited<ReturnType<typeof runAgent>>;
  modelAlias: string;
  attempt: number;
  usedFallback: boolean;
}

export function preparePlannerSubtaskAttempt(
  plan: PlannerPlan,
  requestArtifact: PlannerRequestArtifact,
  stepId: string,
  attempt: number,
  executionState: PlannerStepExecutionState,
  explicitFiles: string[],
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
): { plan: PlannerPlan } {
  const step = plan.steps.find((candidate) => candidate.id === stepId);
  if (!step) {
    return { plan };
  }
  const subtaskId = `subtask-${step.id}`;
  return {
    plan: updatePlannerStep(plan, step.id, {
      status: step.kind === 'verify' ? 'VERIFYING' : 'PATCHING',
      attempts: attempt,
      executionState,
      assignee: 'subagent',
      children: step.children.includes(subtaskId) ? step.children : [...step.children, subtaskId],
      subtaskContext: buildStepContextPacket(requestArtifact, plan, step),
      dependsOnFiles: step.dependsOnFiles ?? explicitFiles,
      fileScope: step.fileScope ?? explicitFiles,
      accessMode: step.accessMode ?? derivePlannerAccessMode(step),
    }),
  };
}

export function prepareLockTableForStep(
  lockTable: ExecutionLockTable,
  plan: PlannerPlan,
  step: PlannerStep,
  fileScope: string[],
): ExecutionLockTable {
  if (derivePlannerAccessMode(step) !== 'write' || fileScope.length === 0) {
    return lockTable;
  }

  let next = lockTable;
  const owners = new Map(lockTable.entries.map((entry) => [entry.path, entry.ownerStepId]));
  for (const filePath of fileScope) {
    const owner = owners.get(filePath);
    if (!owner || owner === step.id) {
      continue;
    }
    if (canTransferOwnership(plan, owner, step.id)) {
      next = transferWriteOwnership(next, owner, step.id, [filePath], plan.revision);
    }
  }

  return acquireWriteLocks(next, step.id, fileScope, plan.revision);
}

export async function executeSubtaskAgent(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  prompt: string,
  explicitFiles: string[],
  enableVerifier: boolean,
  modelAliasOverride: string,
  attempt: number,
  usedFallback: boolean,
  stepId: string,
  lockTable: ExecutionLockTable,
): Promise<SubtaskExecutionOutcome> {
  const subtaskConfig = enableVerifier ? config : {
    ...config,
    verifier: {
      ...config.verifier,
      enabled: false,
      allowDiscovery: false,
      commands: [],
    },
  };
  const policy = new PolicyEngine(subtaskConfig, {
    grantedReadPaths: explicitFiles,
    grantedWritePaths: explicitFiles,
    restrictWritePaths: true,
    writePathValidator: (targetPath) => {
      const relativePath = path.relative(subtaskConfig.workspaceRoot, targetPath).replace(/\\/g, '/');
      assertStepCanWrite(lockTable, stepId, relativePath);
    },
  });
  const registry = new ToolRegistry();
  registry.registerProvider(createBuiltinToolProvider(subtaskConfig, policy));

  const result = await runAgent(subtaskConfig, providers, registry, {
    prompt,
    explicitFiles,
    pastedSnippets: [],
    manualVerifierCommands: [],
    autoApprove: true,
    confirm: async () => true,
    policyOptions: {
      grantedReadPaths: explicitFiles,
      grantedWritePaths: explicitFiles,
      restrictWritePaths: true,
      writePathValidator: (targetPath) => {
        const relativePath = path.relative(subtaskConfig.workspaceRoot, targetPath).replace(/\\/g, '/');
        assertStepCanWrite(lockTable, stepId, relativePath);
      },
    },
    routeOverride: {
      modelAlias: modelAliasOverride,
      intent: 'code',
      maxSteps: config.routing.maxSteps,
      maxAutoRepairAttempts: enableVerifier ? config.routing.maxAutoRepairAttempts : 0,
    },
  });

  return {
    result,
    modelAlias: modelAliasOverride,
    attempt,
    usedFallback,
  };
}

export async function executePlannerSubtaskWithRecovery(
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
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
  feedback?: PlannerExecutionFeedbackArtifact,
): Promise<{ plan: PlannerPlan; state: PlannerState; changedFiles: string[]; stop: boolean; replanned: boolean; lockTable: ExecutionLockTable }> {
  let nextPlan = plan;
  let nextState = state;
  const maxAttempts = step.maxAttempts ?? config.routing.subtaskMaxAttempts;
  const effectiveFileScope = [...new Set([...(step.fileScope ?? []), ...explicitFiles])];
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
    const replanned = await attemptPlannerNodeReplan(config, providers, session, requestArtifact, nextPlan, nextState, step.id, latestFailure.result.message, lockTable, feedback);
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
