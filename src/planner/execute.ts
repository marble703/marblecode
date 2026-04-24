import type { AppConfig } from '../config/schema.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { ModelProvider } from '../provider/types.js';
import { appendPlannerEvent, appendPlannerStructuredLog, writePlannerExecutionArtifacts } from './artifacts.js';
import {
  buildExecutionGraph as buildPlannerExecutionGraph,
  derivePlannerFileScope,
  getReadyStepIds,
} from './graph.js';
import { createExecutionLockTable, downgradeToGuardedRead, type ExecutionLockTable } from './locks.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import { annotateBlockedDependents, detectPendingConflictFailure, mergePlannerStepResult, selectExecutionWave } from './execute-wave.js';
import { executePlannerVerifyStep } from './execute-verify.js';
import { executePlannerSubtaskWithRecovery, prepareLockTableForStep } from './execute-subtask.js';
import { runPlanConsistencyChecks } from './parse.js';
import { buildSubtaskPrompt } from './prompts.js';

type StepClassifier = (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
type StepUpdater = (plan: PlannerPlan, stepId: string, updates: Partial<PlannerStep>) => PlannerPlan;

interface ExecutePlannerDependencies {
  classifyPlannerStep: StepClassifier;
  updatePlannerStep: StepUpdater;
}

export async function executePlannerPlan(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  dependencies: ExecutePlannerDependencies,
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
      nextPlan = dependencies.updatePlannerStep(nextPlan, blockedStep.id, {
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

    const selectedWave = selectExecutionWave(readySteps, executionGraph, config.routing.maxConcurrentSubtasks, dependencies.classifyPlannerStep);
    if (selectedWave.length === 0) {
      break;
    }
    const skippable = selectedWave.filter((step) => dependencies.classifyPlannerStep(step) === 'skip');
    if (skippable.length === selectedWave.length) {
      for (const step of skippable) {
        nextPlan = dependencies.updatePlannerStep(nextPlan, step.id, { status: 'DONE', executionState: 'done' });
        await appendPlannerEvent(session, { type: 'subtask_skipped', stepId: step.id, kind: step.kind, reason: 'Planning-only step' }, config.session.redactSecrets);
      }
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writePlannerExecutionArtifacts(session, executionGraph, lockTable, nextState);
      continue;
    }
    if (selectedWave.length === 1 && dependencies.classifyPlannerStep(selectedWave[0] ?? nextPlan.steps[0] ?? { kind: 'note', title: '', details: '' } as PlannerStep) === 'verify') {
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
          updatePlannerStep: dependencies.updatePlannerStep,
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
      dependencies,
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

export async function executePlannerWave(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  wave: PlannerStep[],
  lockTable: ExecutionLockTable,
  dependencies: ExecutePlannerDependencies,
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
        dependencies.updatePlannerStep,
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
      nextPlan = dependencies.updatePlannerStep(nextPlan, step.id, {
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
    nextPlan = mergePlannerStepResult(nextPlan, value.plan, step.id, dependencies.updatePlannerStep);
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
    nextPlan = annotateBlockedDependents(nextPlan, failedStepIds, dependencies.updatePlannerStep);
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
