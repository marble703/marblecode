import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { writeSessionArtifact, type SessionRecord } from '../session/index.js';
import { runVerifier } from '../verifier/index.js';
import { appendPlannerEvent } from './artifacts.js';
import { buildVerifyRepairPrompt } from './prompts.js';
import { refreshPlannerStateFromPlan } from './state.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import type { ExecutionLockTable } from './locks.js';

export interface PlannerVerifyExecutionResult {
  plan: PlannerPlan;
  state: PlannerState;
  changedFiles: string[];
  stop: boolean;
  lockTable: ExecutionLockTable;
}

interface PlannerVerifyDependencies {
  executePlannerSubtaskWithRecovery: (
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
    updatePlannerStep: (plan: PlannerPlan, stepId: string, updates: Partial<PlannerStep>) => PlannerPlan,
    feedback?: import('./types.js').PlannerExecutionFeedbackArtifact,
  ) => Promise<{
    plan: PlannerPlan;
    state: PlannerState;
    changedFiles: string[];
    stop: boolean;
    replanned: boolean;
    lockTable: ExecutionLockTable;
  }>;
  updatePlannerStep: (plan: PlannerPlan, stepId: string, updates: Partial<PlannerStep>) => PlannerPlan;
}

export async function executePlannerVerifyStep(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  session: SessionRecord,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  step: PlannerStep,
  changedFiles: string[],
  lockTable: ExecutionLockTable,
  dependencies: PlannerVerifyDependencies,
): Promise<PlannerVerifyExecutionResult> {
  let nextPlan = dependencies.updatePlannerStep(plan, step.id, {
    status: 'VERIFYING',
    executionState: 'running',
    attempts: step.attempts + 1,
  });
  let nextState = refreshPlannerStateFromPlan(nextPlan, {
    ...state,
    phase: 'VERIFYING',
    currentStepId: step.id,
    message: `Running final verifier for ${step.title}`,
  });
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  await appendPlannerEvent(session, { type: 'subtask_started', stepId: step.id, executor: 'verifier', title: step.title }, config.session.redactSecrets);

  const verifyResult = await runVerifier(config, new PolicyEngine(config), {
    changedFiles,
    providers,
  });
  await writeSessionArtifact(session, `subtask.${step.id}.verify.json`, JSON.stringify(verifyResult, null, 2));

  if (verifyResult.success) {
    nextPlan = dependencies.updatePlannerStep(nextPlan, step.id, {
      status: 'DONE',
      executionState: 'done',
      relatedFiles: changedFiles,
    });
    nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
    await appendPlannerEvent(session, {
      type: 'subtask_completed',
      stepId: step.id,
      executor: 'verifier',
      success: true,
      changedFiles,
    }, config.session.redactSecrets);
    await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
    await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
    return { plan: nextPlan, state: nextState, changedFiles, stop: false, lockTable };
  }

  await appendPlannerEvent(session, {
    type: 'subtask_verify_failed',
    stepId: step.id,
    executor: 'verifier',
    failures: verifyResult.failures.map((failure) => ({ command: failure.command, stderr: failure.stderr })),
  }, config.session.redactSecrets);

  const repairPrompt = buildVerifyRepairPrompt(requestArtifact, nextPlan, verifyResult);
  const repair = await dependencies.executePlannerSubtaskWithRecovery(
    config,
    providers,
    session,
    requestArtifact,
    nextPlan,
    nextState,
    step,
    repairPrompt,
    changedFiles,
    true,
    false,
    lockTable,
    true,
    dependencies.updatePlannerStep,
  );
  nextPlan = repair.plan;
  nextState = repair.state;
  lockTable = repair.lockTable;
  const mergedChangedFiles = [...new Set([...changedFiles, ...repair.changedFiles])];
  if (repair.stop) {
    return { plan: nextPlan, state: nextState, changedFiles: mergedChangedFiles, stop: true, lockTable };
  }

  nextPlan = dependencies.updatePlannerStep(nextPlan, step.id, {
    status: 'DONE',
    executionState: 'done',
    relatedFiles: mergedChangedFiles,
  });
  nextState = refreshPlannerStateFromPlan(nextPlan, nextState);
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(nextPlan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(nextState, null, 2));
  return { plan: nextPlan, state: nextState, changedFiles: mergedChangedFiles, stop: false, lockTable };
}
