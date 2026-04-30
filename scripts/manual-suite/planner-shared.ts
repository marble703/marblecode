import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { executePlannerPlan } from '../../src/planner/execute.js';
import { createInitialExecutionState, dispatchExecutionEvent, transitionExecutionPhase } from '../../src/planner/execution-machine.js';
import {
  buildExecutionDispatchSnapshot,
  buildInitialExecutionRuntimeContext,
  buildInitialExecutionStateExtras,
  clearInterruptedWave,
  copyPersistedRecoverySnapshot,
  createInitialExecutionRuntimeCursor,
  markPlanningWindowCompleted,
  markRecoveryFallback,
  markWaveCompleted,
  markWaveSelected,
} from '../../src/planner/execution-state.js';
import { getPlannerExecutionStrategy } from '../../src/planner/execution-strategies.js';
import { executePlannerSubtaskWithRecovery, prepareLockTableForStep } from '../../src/planner/execute-subtask.js';
import { annotateBlockedDependents, detectPendingConflictFailure, selectExecutionWave } from '../../src/planner/execute-wave.js';
import { executePlannerVerifyStep } from '../../src/planner/execute-verify.js';
import { buildExecutionGraph, getReadyStepIds } from '../../src/planner/graph.js';
import { runPlanner } from '../../src/planner/index.js';
import { acquireWriteLocks, assertStepCanWrite, createExecutionLockTable, downgradeToGuardedRead, transferWriteOwnership } from '../../src/planner/locks.js';
import {
  buildPlannerAffectedSubgraph,
  collectReplanScope,
  computeUndeclaredChangedFiles,
  mergePlanAppend,
  mergeReplanProposal,
  validateAppendActiveWaveConflict,
  validatePlanAppend,
  validateReplanLockCompatibility,
  validateReplanProposal,
} from '../../src/planner/replan-merge.js';
import { buildPlannerRequestArtifact, classifyPlannerStep, initializePlannerState, mapPlannerResult, updatePlannerStep } from '../../src/planner/runtime.js';
import { createSession } from '../../src/session/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import type { ModelProvider } from '../../src/provider/types.js';
import {
  assertPlannerEvent,
  assertPlannerLogEntry,
  assertToolLogEntry,
  buildMathFixStep,
  buildNotesOnlyStep,
  createExecutionLocks,
  createExecutionState,
  createPlannerPlan,
  createPlannerRegistry,
  createPlannerState,
  withWorkspace,
  writePlannerArtifacts,
  writePlannerEvents,
} from './helpers.js';
import { BranchingProvider, FlakyProvider, SequenceProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export {
  acquireWriteLocks,
  annotateBlockedDependents,
  assert,
  assertStepCanWrite,
  assertPlannerEvent,
  assertPlannerLogEntry,
  assertToolLogEntry,
  BranchingProvider,
  buildExecutionGraph,
  buildExecutionDispatchSnapshot,
  createExecutionLocks,
  createExecutionState,
  buildInitialExecutionRuntimeContext,
  buildInitialExecutionStateExtras,
  clearInterruptedWave,
  copyPersistedRecoverySnapshot,
  createInitialExecutionRuntimeCursor,
  createPlannerPlan,
  createPlannerState,
  buildMathFixStep,
  buildNotesOnlyStep,
  buildPlannerAffectedSubgraph,
  buildPlannerRequestArtifact,
  classifyPlannerStep,
  collectReplanScope,
  computeUndeclaredChangedFiles,
  createExecutionLockTable,
  createInitialExecutionState,
  createPlannerRegistry,
  createSession,
  detectPendingConflictFailure,
  dispatchExecutionEvent,
  downgradeToGuardedRead,
  executePlannerPlan,
  executePlannerSubtaskWithRecovery,
  executePlannerVerifyStep,
  FlakyProvider,
  getPlannerExecutionStrategy,
  getReadyStepIds,
  initializePlannerState,
  markPlanningWindowCompleted,
  markRecoveryFallback,
  markWaveCompleted,
  markWaveSelected,
  mapPlannerResult,
  mergePlanAppend,
  mergeReplanProposal,
  mkdir,
  path,
  PolicyEngine,
  prepareLockTableForStep,
  readFile,
  runPlanner,
  selectExecutionWave,
  SequenceProvider,
  transferWriteOwnership,
  transitionExecutionPhase,
  updatePlannerStep,
  validateAppendActiveWaveConflict,
  validatePlanAppend,
  validateReplanLockCompatibility,
  validateReplanProposal,
  withWorkspace,
  writeFile,
  writePlannerArtifacts,
  writePlannerEvents,
};

export type { ManualSuiteCase, ModelProvider };
