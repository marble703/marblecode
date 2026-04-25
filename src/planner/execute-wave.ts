import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from '../provider/types.js';
import type { SessionRecord } from '../session/index.js';
import { appendPlannerEvent } from './artifacts.js';
import { derivePlannerAccessMode, derivePlannerFileScope, type PlannerExecutionGraph } from './graph.js';
import { downgradeToGuardedRead, type ExecutionLockTable } from './locks.js';
import { buildSubtaskPrompt } from './prompts.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import { executePlannerSubtaskWithRecovery, prepareLockTableForStep } from './execute-subtask.js';

export function selectExecutionWave(
  readySteps: PlannerStep[],
  graph: PlannerExecutionGraph,
  maxConcurrentSubtasks: number,
  classifyStep: (step: PlannerStep) => 'skip' | 'subagent' | 'verify',
): PlannerStep[] {
  const readyById = new Map(readySteps.map((step) => [step.id, step]));
  for (const wave of graph.waves) {
    const candidates = wave.stepIds
      .map((stepId) => readyById.get(stepId))
      .filter((step): step is PlannerStep => Boolean(step));
    if (candidates.length === 0) {
      continue;
    }
    const verify = candidates.find((step) => classifyStep(step) === 'verify');
    if (verify) {
      return [verify];
    }
    if (maxConcurrentSubtasks <= 1) {
      return [candidates[0]].filter((step): step is PlannerStep => Boolean(step));
    }
    const restricted = candidates.filter((step) => derivePlannerAccessMode(step) === 'write' && derivePlannerFileScope(step).length === 0);
    if (restricted.length > 0) {
      return [restricted[0]].filter((step): step is PlannerStep => Boolean(step));
    }
    return candidates.slice(0, maxConcurrentSubtasks);
  }

  return readySteps.length > 0 ? [readySteps[0]].filter((step): step is PlannerStep => Boolean(step)) : [];
}

export function detectPendingConflictFailure(plan: PlannerPlan, graph: PlannerExecutionGraph): string | null {
  const pending = new Set(plan.steps.filter((step) => step.status !== 'DONE' && step.status !== 'FAILED').map((step) => step.id));
  const edge = graph.edges.find((candidate) => candidate.type === 'conflict' && pending.has(candidate.from) && pending.has(candidate.to));
  if (!edge) {
    return null;
  }

  return `Planner execution conflict detected between ${edge.from} and ${edge.to}.`;
}

export function mergePlannerStepResult(
  basePlan: PlannerPlan,
  updatedPlan: PlannerPlan,
  stepId: string,
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
): PlannerPlan {
  const updatedStep = updatedPlan.steps.find((step) => step.id === stepId);
  if (!updatedStep) {
    return basePlan;
  }
  return updatePlannerStep(basePlan, stepId, updatedStep);
}

export function annotateBlockedDependents(
  plan: PlannerPlan,
  failedStepIds: Set<string>,
  updatePlannerStep: (plan: PlannerPlan, targetStepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
): PlannerPlan {
  let nextPlan = plan;
  for (const step of plan.steps) {
    if (step.status === 'DONE' || step.status === 'FAILED') {
      continue;
    }

    const blockingDependencies = step.dependencies.filter((dependency) => failedStepIds.has(dependency));
    if (blockingDependencies.length === 0) {
      continue;
    }

    const message = `Blocked by failed dependencies: ${blockingDependencies.join(', ')}`;
    nextPlan = updatePlannerStep(nextPlan, step.id, {
      executionState: 'blocked',
      failureKind: 'dependency',
      lastError: message,
      details: message,
    });
  }

  return nextPlan;
}

export async function executePlannerWave(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  wave: PlannerStep[],
  lockTable: ExecutionLockTable,
  updatePlannerStep: (plan: PlannerPlan, stepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
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
        updatePlannerStep,
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
