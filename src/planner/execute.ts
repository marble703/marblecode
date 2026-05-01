import type { AppConfig } from '../config/schema.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { ModelProvider } from '../provider/types.js';
import { appendPlannerEvent, appendPlannerStructuredLog, writePlannerExecutionFeedbackArtifact } from './artifacts.js';
import { createInitialExecutionState, dispatchExecutionEvent, type PlannerExecutionEvent, type PlannerExecutionSnapshotInput } from './execution-machine.js';
import { getPlannerExecutionStrategy } from './execution-strategies.js';
import {
  buildExecutionGraph as buildPlannerExecutionGraph,
  findPendingConflictSummary,
  getReadyStepIds,
  getStructuredBlockedReasons,
} from './graph.js';
import { createExecutionLockTable } from './locks.js';
import { refreshPlannerStateFromPlan } from './state.js';
import {
  buildExecutionDispatchSnapshot,
  buildInitialExecutionRuntimeContext,
  buildInitialExecutionStateExtras,
  clearInterruptedWave,
  createInitialExecutionRuntimeCursor,
  markPlanningWindowCompleted,
  markRecoveryFallback,
  summarizeActiveLockOwners,
  markWaveCompleted,
  markWaveSelected,
} from './execution-state.js';
import type { PlannerExecutionFeedbackArtifact, PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import type { PlannerExecutionStateArtifact } from './execution-types.js';
import { executePlannerWave } from './execute-wave.js';
import { executePlannerVerifyStep } from './execute-verify.js';
import { executePlannerSubtaskWithRecovery } from './execute-subtask.js';
import {
  createDependencyBlockedOutcome,
  createExecutionCompletionOutcome,
  createPlanningWindowCompletionOutcome,
  createRuntimeLockBlockedOutcome,
  createSkipBatchOutcome,
  createVerifyFeedbackOutcome,
  createWaveFeedbackOutcome,
  decidePlannerExecutionTurn,
} from './execution-runner.js';
import { runPlanConsistencyChecks } from './parse.js';
import { buildPlannerAffectedSubgraph, computeUndeclaredChangedFiles } from './replan-merge.js';
import { attemptPlannerNodeReplan } from './recovery.js';

type StepClassifier = (step: PlannerStep) => 'skip' | 'subagent' | 'verify';
type StepUpdater = (plan: PlannerPlan, stepId: string, updates: Partial<PlannerStep>) => PlannerPlan;

interface ExecutePlannerDependencies {
  classifyPlannerStep: StepClassifier;
  updatePlannerStep: StepUpdater;
}

interface ExecutePlannerInitialContext {
  lockTable?: ReturnType<typeof createExecutionLockTable>;
  executionState?: PlannerExecutionStateArtifact;
}

export async function executePlannerPlan(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  dependencies: ExecutePlannerDependencies,
  initialContext?: ExecutePlannerInitialContext,
): Promise<{ plan: PlannerPlan; state: PlannerState }> {
  const accumulatedChangedFiles = new Set<string>();
  const strategy = getPlannerExecutionStrategy(config.routing.subtaskConflictPolicy);
  let nextPlan = plan;
  let executionGraph = buildPlannerExecutionGraph(nextPlan, strategy.mode === 'fail' ? 'fail' : 'serial');
  const initialRuntime = buildInitialExecutionRuntimeContext(
    initialContext?.lockTable ?? createExecutionLockTable(nextPlan.revision),
    initialContext?.executionState,
  );
  let lockTable = initialRuntime.lockTable;
  let nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...state,
    phase: 'PATCHING',
    message: 'Planner finished planning. Starting subtask execution.',
  });
  let runtimeCursor = createInitialExecutionRuntimeCursor(initialRuntime);
  let executionState = createInitialExecutionState(nextState, strategy.mode, buildInitialExecutionStateExtras(runtimeCursor, initialRuntime));
  let executedWaveCount = 0;

  const dispatchExecution = async (
    event: PlannerExecutionEvent,
    extras?: Omit<PlannerExecutionSnapshotInput, 'state' | 'strategy' | 'currentWaveStepIds' | 'lastCompletedWaveStepIds' | 'epoch' | 'selectedWaveStepIds' | 'interruptedStepIds' | 'planningWindowState'>,
  ): Promise<void> => {
    const snapshot = buildExecutionDispatchSnapshot({
      state: nextState,
      strategy: strategy.mode,
      lockTable,
      executionState,
      currentWaveStepIds: runtimeCursor.currentWaveStepIds,
      lastCompletedWaveStepIds: runtimeCursor.lastCompletedWaveStepIds,
      selectedWaveStepIds: runtimeCursor.selectedWaveStepIds,
      interruptedStepIds: runtimeCursor.interruptedStepIds,
      epoch: runtimeCursor.epoch,
      planningWindowState: runtimeCursor.planningWindowState,
      ...(extras?.recoveryStepId ? { recoveryStepId: extras.recoveryStepId } : {}),
      ...(extras?.recoveryReason ? { recoveryReason: extras.recoveryReason } : {}),
      ...(extras?.blockedReasons ? { blockedReasons: extras.blockedReasons } : {}),
      ...(extras?.latestConflict ? { latestConflict: extras.latestConflict } : {}),
    });
    executionState = await dispatchExecutionEvent(
      session,
      executionGraph,
      lockTable,
      executionState,
      event,
      snapshot,
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
      const conflict = findPendingConflictSummary(nextPlan, executionGraph);
      nextState = {
        ...nextState,
        outcome: 'FAILED',
        phase: 'BLOCKED',
        message: conflict?.message ?? conflictError,
      };
      await appendPlannerEvent(session, {
        type: 'subtask_conflict_detected',
        reason: conflict?.message ?? conflictError,
        ...(conflict ? {
          fromStepId: conflict.fromStepId,
          toStepId: conflict.toStepId,
          conflictReason: conflict.reason,
          ...(conflict.domain ? { conflictDomain: conflict.domain } : {}),
        } : {}),
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'CONFLICT_DETECTED' }, {
        ...(conflict ? { latestConflict: conflict, lastEventReason: conflict.message } : { lastEventReason: conflictError }),
      });
      return { plan: nextPlan, state: nextState };
    }

    const turn = decidePlannerExecutionTurn({
      plan: nextPlan,
      lockTable,
      strategyMode: strategy.mode,
      maxConcurrentSubtasks: config.routing.maxConcurrentSubtasks,
      classifyPlannerStep: dependencies.classifyPlannerStep,
      getReadySteps: (candidatePlan) => getReadyStepIds(candidatePlan, nextState, executionGraph)
        .map((stepId) => candidatePlan.steps.find((step) => step.id === stepId))
        .filter((step): step is PlannerStep => Boolean(step)),
      selectLegacyWave: (readySteps) => strategy.selectWave(
        readySteps,
        executionGraph,
        config.routing.maxConcurrentSubtasks,
        dependencies.classifyPlannerStep,
      ),
    });
    if (turn.kind === 'complete') {
      break;
    }
    if (turn.kind === 'blocked_no_ready') {
      const blockedStep = turn.pendingSteps[0];
      if (!blockedStep) {
        break;
      }
      const blockedReasons = getStructuredBlockedReasons(blockedStep, nextPlan, executionGraph);
      const blockedOutcome = createDependencyBlockedOutcome({ step: blockedStep, blockedReasons });
      nextPlan = dependencies.updatePlannerStep(nextPlan, blockedStep.id, blockedOutcome.stepUpdates);
      nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...nextState,
        ...blockedOutcome.statePatch,
      });
      await appendPlannerEvent(session, {
        type: 'subtask_blocked',
        stepId: blockedStep.id,
        reason: blockedOutcome.event.reason,
        blockedByStepIds: blockedOutcome.event.blockedByStepIds,
        ...(blockedOutcome.event.blockedReasons ? { blockedReasons: blockedOutcome.event.blockedReasons } : {}),
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'DEPENDENCIES_BLOCKED' }, blockedOutcome.dispatch);
      return { plan: nextPlan, state: nextState };
    }

    if (turn.kind === 'blocked_runtime_locks') {
      const blockedStep = turn.readySteps[0] ?? turn.pendingSteps[0];
      if (!blockedStep) {
        break;
      }
      const activeLockOwners = summarizeActiveLockOwners(lockTable);
      const blockedOutcome = createRuntimeLockBlockedOutcome({ step: blockedStep, activeLockOwners });
      nextPlan = dependencies.updatePlannerStep(nextPlan, blockedStep.id, blockedOutcome.stepUpdates);
      nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...nextState,
        ...blockedOutcome.statePatch,
      });
      await appendPlannerEvent(session, {
        type: 'subtask_blocked',
        stepId: blockedStep.id,
        reason: blockedOutcome.event.reason,
        blockedByStepIds: blockedOutcome.event.blockedByStepIds,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'DEPENDENCIES_BLOCKED' }, blockedOutcome.dispatch);
      return { plan: nextPlan, state: nextState };
    }
    const selectedExecutionBatch = turn.batch;
    if (selectedExecutionBatch.length === 0) {
      break;
    }
    runtimeCursor = markWaveSelected(runtimeCursor, selectedExecutionBatch.map((step) => step.id));
    const skippable = selectedExecutionBatch.filter((step) => dependencies.classifyPlannerStep(step) === 'skip');
    if (skippable.length === selectedExecutionBatch.length) {
      const skipOutcome = createSkipBatchOutcome(skippable);
      for (const update of skipOutcome.stepUpdates) {
        nextPlan = dependencies.updatePlannerStep(nextPlan, update.stepId, update.updates);
      }
      for (const event of skipOutcome.events) {
        await appendPlannerEvent(session, { type: 'subtask_skipped', stepId: event.stepId, kind: event.kind, reason: event.reason }, config.session.redactSecrets);
      }
      nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      runtimeCursor = markWaveCompleted(runtimeCursor);
      await dispatchExecution({ type: 'SKIP_WAVE_COMPLETED' });
      continue;
    }
    if (selectedExecutionBatch.length === 1 && dependencies.classifyPlannerStep(selectedExecutionBatch[0] ?? nextPlan.steps[0] ?? { kind: 'note', title: '', details: '' } as PlannerStep) === 'verify') {
      const step = selectedExecutionBatch[0];
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
      runtimeCursor = markWaveCompleted(runtimeCursor);
      await dispatchExecution({ type: verifyResult.stop ? 'VERIFY_STEP_FAILED' : 'VERIFY_STEP_SUCCEEDED' });
      {
        const verifyStep = nextPlan.steps.find((candidate) => candidate.id === step.id) ?? step;
        const verifyFeedbackOutcome = createVerifyFeedbackOutcome({
          step,
          status: verifyStep.status,
          changedFiles: verifyResult.changedFiles,
          message: nextState.message,
          stop: verifyResult.stop,
          executionEpoch: runtimeCursor.epoch,
        });
        const feedback: PlannerExecutionFeedbackArtifact = {
          ...verifyFeedbackOutcome.feedback,
          planRevision: nextPlan.revision,
        };
        await writePlannerExecutionFeedbackArtifact(session, feedback);
        if (verifyFeedbackOutcome.verifyFailedEvent) {
          await appendPlannerEvent(session, {
            type: 'execution_feedback_verify_failed',
            stepId: verifyFeedbackOutcome.verifyFailedEvent.stepId,
            epoch: verifyFeedbackOutcome.verifyFailedEvent.epoch,
          }, config.session.redactSecrets);
        }
      }
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
      selectedExecutionBatch,
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

    {
      const waveFeedbackOutcome = createWaveFeedbackOutcome({
        selectedSteps: selectedExecutionBatch,
        currentPlan: nextPlan,
        waveFeedback: waveResult.stepFeedback,
        changedFiles: waveResult.changedFiles,
        executionEpoch: runtimeCursor.epoch,
        computeUndeclaredChangedFiles,
      });
      const feedback: PlannerExecutionFeedbackArtifact = waveFeedbackOutcome.feedback;
      await writePlannerExecutionFeedbackArtifact(session, feedback);
      if (waveFeedbackOutcome.replanEvent) {
        await appendPlannerEvent(session, {
          type: 'execution_feedback_undeclared_files',
          epoch: waveFeedbackOutcome.replanEvent.epoch,
          undeclaredFiles: waveFeedbackOutcome.replanEvent.undeclaredFiles,
          triggerReplan: waveFeedbackOutcome.replanEvent.triggerReplan,
        }, config.session.redactSecrets);
        const firstFailed = feedback.stepSummaries[0];
        if (firstFailed && config.routing.subtaskReplanOnFailure) {
          const affected = buildPlannerAffectedSubgraph(nextPlan, firstFailed.stepId, feedback.undeclaredChangedFiles);
          await appendPlannerEvent(session, {
            type: 'execution_feedback_replan_scope',
            stepId: firstFailed.stepId,
            affectedStepIds: [...affected],
          }, config.session.redactSecrets);
          const replanned = await attemptPlannerNodeReplan(
            config,
            providers,
            session,
            requestArtifact,
            nextPlan,
            nextState,
            firstFailed.stepId,
            feedback.replanReason,
            lockTable,
            feedback,
          );
          if (replanned) {
            nextPlan = replanned.plan;
            nextState = replanned.state;
            runtimeCursor = clearInterruptedWave(runtimeCursor);
            await dispatchExecution({ type: 'WAVE_REPLANNED' }, {
              recoveryStepId: firstFailed.stepId,
              recoveryReason: feedback.replanReason,
            });
            continue;
          }
        }
      }
    }
    if (waveResult.fallbackActivated) {
      runtimeCursor = markRecoveryFallback(runtimeCursor, waveResult.activatedFallbackStepIds);
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
      runtimeCursor = clearInterruptedWave(runtimeCursor);
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
    runtimeCursor = markWaveCompleted(runtimeCursor);
    executedWaveCount += 1;
    await dispatchExecution({ type: 'WAVE_CONVERGED' });
    if (nextPlan.isPartial === true && executedWaveCount >= config.routing.planningWindowWaves) {
      runtimeCursor = markPlanningWindowCompleted(runtimeCursor);
      const windowCompletion = createPlanningWindowCompletionOutcome({
        plan: nextPlan,
        executedWaveCount,
        planningWindowWaves: config.routing.planningWindowWaves,
        consistencyErrors: runPlanConsistencyChecks(nextPlan),
      });
      nextState = refreshPlannerStateFromPlan(nextPlan, {
        ...nextState,
        ...windowCompletion.statePatch,
      });
      await appendPlannerEvent(session, {
        type: 'planner_execution_window_completed',
        ...windowCompletion.windowEvent,
      }, config.session.redactSecrets);
      await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
      await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
      await dispatchExecution({ type: 'EXECUTION_COMPLETED' });
      return { plan: nextPlan, state: nextState };
    }
  }

  const completionOutcome = createExecutionCompletionOutcome({
    degradedStepIds: nextState.degradedStepIds ?? [],
    consistencyErrors: runPlanConsistencyChecks(nextPlan),
  });
  nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...nextState,
    ...completionOutcome.statePatch,
  });

  await appendPlannerEvent(session, {
    type: 'planner_execution_finished',
    ...completionOutcome.finishEvent,
  }, config.session.redactSecrets);
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  await dispatchExecution({ type: 'EXECUTION_COMPLETED' });
  return { plan: nextPlan, state: nextState };
}
