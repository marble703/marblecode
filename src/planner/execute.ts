import type { AppConfig } from '../config/schema.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { ModelProvider } from '../provider/types.js';
import { appendPlannerEvent, appendPlannerStructuredLog, writePlannerExecutionArtifacts } from './artifacts.js';
import { createPlannerExecutionState } from './execution-state.js';
import { getPlannerExecutionStrategy } from './execution-strategies.js';
import {
  buildExecutionGraph as buildPlannerExecutionGraph,
  getReadyStepIds,
} from './graph.js';
import { createExecutionLockTable } from './locks.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerExecutionPhase } from './execution-types.js';
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
  let executionPhase: PlannerExecutionPhase = 'planning';
  let currentWaveStepIds: string[] = [];
  let lastCompletedWaveStepIds: string[] = [];
  let executionEpoch = 0;

  const writeExecutionArtifacts = async (
    phase: PlannerExecutionPhase,
    extras?: {
      currentWaveStepIds?: string[];
      lastCompletedWaveStepIds?: string[];
      recoveryStepId?: string;
      recoveryReason?: string;
    },
  ): Promise<void> => {
    executionPhase = phase;
    if (extras?.currentWaveStepIds) {
      currentWaveStepIds = extras.currentWaveStepIds;
    }
    if (extras?.lastCompletedWaveStepIds) {
      lastCompletedWaveStepIds = extras.lastCompletedWaveStepIds;
    }
    await writePlannerExecutionArtifacts(
      session,
      executionGraph,
      lockTable,
      createPlannerExecutionState(nextState, strategy.mode, executionPhase, {
        currentWaveStepIds,
        lastCompletedWaveStepIds,
        epoch: executionEpoch,
        ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
        ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
      }),
    );
  };

  await appendPlannerEvent(session, { type: 'planner_execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await appendPlannerStructuredLog(session, { type: 'execution_started', revision: nextPlan.revision }, config.session.redactSecrets);
  await writeExecutionArtifacts('planning');

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
      await writeExecutionArtifacts('failed');
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
      await writeExecutionArtifacts('failed', {
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
      await writeExecutionArtifacts('converging');
      continue;
    }
    if (selectedWave.length === 1 && dependencies.classifyPlannerStep(selectedWave[0] ?? nextPlan.steps[0] ?? { kind: 'note', title: '', details: '' } as PlannerStep) === 'verify') {
      const step = selectedWave[0];
      if (!step) {
        break;
      }
      await writeExecutionArtifacts('executing_wave');
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
      await writeExecutionArtifacts(verifyResult.stop ? 'failed' : 'converging');
      if (verifyResult.stop) {
        return { plan: nextPlan, state: nextState };
      }
      continue;
    }

    await writeExecutionArtifacts('locking');
    const waveResult = await executePlannerWave(
      config,
      providers,
      session,
      requestArtifact,
      nextPlan,
      nextState,
      selectedWave,
      lockTable,
      dependencies.updatePlannerStep,
    );
    await writeExecutionArtifacts(waveResult.replanned ? 'recovering' : 'executing_wave');
    nextPlan = waveResult.plan;
    nextState = waveResult.state;
    lockTable = waveResult.lockTable;
    for (const file of waveResult.changedFiles) {
      accumulatedChangedFiles.add(file);
    }
    if (waveResult.replanned) {
      currentWaveStepIds = [];
      await writeExecutionArtifacts('recovering', {
        ...(nextState.lastReplanReason ? { recoveryReason: nextState.lastReplanReason } : {}),
      });
      continue;
    }
    if (waveResult.stop) {
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await writeExecutionArtifacts('failed', {
        ...(nextState.currentStepId ? { recoveryStepId: nextState.currentStepId } : {}),
        recoveryReason: nextState.message,
      });
      return { plan: nextPlan, state: nextState };
    }
    lastCompletedWaveStepIds = currentWaveStepIds;
    currentWaveStepIds = [];
    await writeExecutionArtifacts('converging');
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
  await writeExecutionArtifacts('done');
  return { plan: nextPlan, state: nextState };
}
