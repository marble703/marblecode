import type { AppConfig } from '../config/schema.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { ModelProvider } from '../provider/types.js';
import { appendPlannerEvent, appendPlannerStructuredLog } from './artifacts.js';
import { createInitialExecutionState, dispatchExecutionEvent, type PlannerExecutionEvent } from './execution-machine.js';
import { getPlannerExecutionStrategy } from './execution-strategies.js';
import {
  buildExecutionGraph as buildPlannerExecutionGraph,
  getReadyStepIds,
} from './graph.js';
import { createExecutionLockTable } from './locks.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import { executePlannerWave } from './execute-wave.js';
import { executePlannerVerifyStep } from './execute-verify.js';
import { executePlannerSubtaskWithRecovery } from './execute-subtask.js';
import { runPlanConsistencyChecks } from './parse.js';

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
  const strategy = getPlannerExecutionStrategy(config.routing.subtaskConflictPolicy);
  let nextPlan = plan;
  let executionGraph = buildPlannerExecutionGraph(nextPlan, strategy.mode === 'fail' ? 'fail' : 'serial');
  let lockTable = createExecutionLockTable(nextPlan.revision);
  let nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...state,
    phase: 'PATCHING',
    message: 'Planner finished planning. Starting subtask execution.',
  });
  let executionState = createInitialExecutionState(nextState, strategy.mode);
  let currentWaveStepIds: string[] = [];
  let lastCompletedWaveStepIds: string[] = [];
  let executionEpoch = 0;

  const dispatchExecution = async (
    event: PlannerExecutionEvent,
    extras?: {
      recoveryStepId?: string;
      recoveryReason?: string;
    },
  ): Promise<void> => {
    executionState = await dispatchExecutionEvent(
      session,
      executionGraph,
      lockTable,
      executionState,
      event,
      {
        state: nextState,
        strategy: strategy.mode,
        currentWaveStepIds,
        lastCompletedWaveStepIds,
        epoch: executionEpoch,
        ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
        ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
      },
    );
  };

  await appendPlannerEvent(session, { type: 'planner_execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await appendPlannerStructuredLog(session, { type: 'execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await dispatchExecution({ type: 'EXECUTION_INITIALIZED' });

  while (true) {
    executionGraph = buildPlannerExecutionGraph(nextPlan, strategy.mode === 'fail' ? 'fail' : 'serial');
    nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
    const conflictError = strategy.checkConflicts(nextPlan, executionGraph);
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
      await dispatchExecution({ type: 'CONFLICT_DETECTED' });
      return { plan: nextPlan, state: nextState };
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
      await dispatchExecution({ type: 'DEPENDENCIES_BLOCKED' }, {
        recoveryStepId: blockedStep.id,
        recoveryReason: nextState.message,
      });
      return { plan: nextPlan, state: nextState };
    }

    const selectedWave = strategy.selectWave(readySteps, executionGraph, config.routing.maxConcurrentSubtasks, dependencies.classifyPlannerStep);
    if (selectedWave.length === 0) {
      break;
    }
    currentWaveStepIds = selectedWave.map((step) => step.id);
    executionEpoch += 1;
    const skippable = selectedWave.filter((step) => dependencies.classifyPlannerStep(step) === 'skip');
    if (skippable.length === selectedWave.length) {
      for (const step of skippable) {
        nextPlan = dependencies.updatePlannerStep(nextPlan, step.id, { status: 'DONE', executionState: 'done' });
        await appendPlannerEvent(session, { type: 'subtask_skipped', stepId: step.id, kind: step.kind, reason: 'Planning-only step' }, config.session.redactSecrets);
      }
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      lastCompletedWaveStepIds = currentWaveStepIds;
      currentWaveStepIds = [];
      await dispatchExecution({ type: 'SKIP_WAVE_COMPLETED' });
      continue;
    }
    if (selectedWave.length === 1 && dependencies.classifyPlannerStep(selectedWave[0] ?? nextPlan.steps[0] ?? { kind: 'note', title: '', details: '' } as PlannerStep) === 'verify') {
      const step = selectedWave[0];
      if (!step) {
        break;
      }
      await dispatchExecution({ type: 'VERIFY_STEP_STARTED' });
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
      lastCompletedWaveStepIds = currentWaveStepIds;
      currentWaveStepIds = [];
      await dispatchExecution({ type: verifyResult.stop ? 'VERIFY_STEP_FAILED' : 'VERIFY_STEP_SUCCEEDED' });
      if (verifyResult.stop) {
        return { plan: nextPlan, state: nextState };
      }
      continue;
    }

    await dispatchExecution({ type: 'LOCKS_ACQUIRED' });
    const waveResult = await executePlannerWave(
      config,
      providers,
      session,
      requestArtifact,
      nextPlan,
      nextState,
      selectedWave,
      executionGraph,
      lockTable,
      dependencies.updatePlannerStep,
    );
    await dispatchExecution({ type: waveResult.replanned ? 'WAVE_REPLANNED' : 'WAVE_EXECUTED' });
    nextPlan = waveResult.plan;
    nextState = waveResult.state;
    lockTable = waveResult.lockTable;
    for (const file of waveResult.changedFiles) {
      accumulatedChangedFiles.add(file);
    }
    if (waveResult.fallbackActivated) {
      currentWaveStepIds = [];
      executionGraph = buildPlannerExecutionGraph(nextPlan, strategy.mode === 'fail' ? 'fail' : 'serial');
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'FALLBACK_ACTIVATED' }, {
        ...(waveResult.activatedFallbackStepIds[0] ?? nextState.currentStepId ? { recoveryStepId: waveResult.activatedFallbackStepIds[0] ?? nextState.currentStepId ?? '' } : {}),
        recoveryReason: nextState.message,
      });
      continue;
    }
    if (waveResult.replanned) {
      currentWaveStepIds = [];
      await dispatchExecution({ type: 'WAVE_REPLANNED' }, {
        ...(nextState.lastReplanReason ? { recoveryReason: nextState.lastReplanReason } : {}),
      });
      continue;
    }
    if (waveResult.stop) {
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'WAVE_FAILED' }, {
        ...(nextState.currentStepId ? { recoveryStepId: nextState.currentStepId } : {}),
        recoveryReason: nextState.message,
      });
      return { plan: nextPlan, state: nextState };
    }
    lastCompletedWaveStepIds = currentWaveStepIds;
    currentWaveStepIds = [];
    await dispatchExecution({ type: 'WAVE_CONVERGED' });
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
  await dispatchExecution({ type: 'EXECUTION_COMPLETED' });
  return { plan: nextPlan, state: nextState };
}
