import path from 'node:path';
import { runAgent } from '../agent/index.js';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { createBuiltinTools } from '../tools/builtins.js';
import { ToolRegistry } from '../tools/registry.js';
import { derivePlannerAccessMode } from './graph.js';
import {
  acquireWriteLocks,
  assertStepCanWrite,
  transferWriteOwnership,
  type ExecutionLockTable,
} from './locks.js';
import { buildStepContextPacket } from './prompts.js';
import type { PlannerPlan, PlannerRequestArtifact, PlannerStep, PlannerStepExecutionState } from './types.js';

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
  for (const tool of createBuiltinTools(subtaskConfig, policy)) {
    registry.register(tool);
  }

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

function canTransferOwnership(plan: PlannerPlan, fromStepId: string, toStepId: string): boolean {
  const target = plan.steps.find((step) => step.id === toStepId);
  if (!target) {
    return false;
  }
  return target.dependencies.includes(fromStepId)
    || (target.mustRunAfter ?? []).includes(fromStepId)
    || plan.steps.find((step) => step.id === fromStepId)?.ownershipTransfers?.includes(toStepId)
    || fromStepId === toStepId;
}
