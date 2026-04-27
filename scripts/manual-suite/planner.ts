import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { executePlannerPlan } from '../../src/planner/execute.js';
import { createInitialExecutionState, dispatchExecutionEvent, transitionExecutionPhase } from '../../src/planner/execution-machine.js';
import { getPlannerExecutionStrategy } from '../../src/planner/execution-strategies.js';
import { executePlannerSubtaskWithRecovery, prepareLockTableForStep } from '../../src/planner/execute-subtask.js';
import { annotateBlockedDependents, detectPendingConflictFailure, selectExecutionWave } from '../../src/planner/execute-wave.js';
import { executePlannerVerifyStep } from '../../src/planner/execute-verify.js';
import { buildExecutionGraph, getReadyStepIds } from '../../src/planner/graph.js';
import { runPlanner } from '../../src/planner/index.js';
import { acquireWriteLocks, assertStepCanWrite, createExecutionLockTable, downgradeToGuardedRead, transferWriteOwnership } from '../../src/planner/locks.js';
import { buildPlannerAffectedSubgraph, collectReplanScope, computeUndeclaredChangedFiles, mergePlanAppend, mergeReplanProposal, validateAppendActiveWaveConflict, validatePlanAppend, validateReplanLockCompatibility, validateReplanProposal } from '../../src/planner/replan-merge.js';
import { buildPlannerRequestArtifact, classifyPlannerStep, initializePlannerState, mapPlannerResult, updatePlannerStep } from '../../src/planner/runtime.js';
import { createSession } from '../../src/session/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { buildMathFixStep, buildNotesOnlyStep, createPlannerRegistry, withWorkspace } from './helpers.js';
import { BranchingProvider, FlakyProvider, SequenceProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createPlannerCases(): ManualSuiteCase[] {
  return [
    { name: 'planner graph and waves', run: testPlannerGraphAndWaves },
    { name: 'planner graph fallback readiness', run: testPlannerGraphFallbackReadiness },
    { name: 'planner execution locks', run: testPlannerExecutionLocks },
    { name: 'planner runtime helpers', run: testPlannerRuntimeHelpers },
    { name: 'planner execution state machine transitions', run: testPlannerExecutionStateMachineTransitions },
    { name: 'planner execution event dispatch', run: testPlannerExecutionEventDispatch },
    { name: 'planner execution strategies', run: testPlannerExecutionStrategies },
    { name: 'planner conflict domains', run: testPlannerConflictDomains },
    { name: 'planner replan proposal validation', run: testPlannerReplanProposalValidation },
    { name: 'planner plan append validation', run: testPlannerPlanAppendValidation },
    { name: 'planner replan lock compatibility', run: testPlannerReplanLockCompatibility },
    { name: 'planner execute entry helper', run: testPlannerExecuteEntryHelper },
    { name: 'planner verify helper', run: testPlannerVerifyHelper },
    { name: 'planner subtask recovery helper', run: testPlannerSubtaskRecoveryHelper },
    { name: 'planner read-only flow', run: testPlannerReadOnlyFlow },
    { name: 'planner invalid retry and resume', run: testPlannerInvalidRetryAndResume },
    { name: 'planner execute resume from artifacts', run: testPlannerExecuteResumeFromArtifacts },
    { name: 'planner model retry', run: testPlannerModelRetry },
    { name: 'planner model retry exhaustion', run: testPlannerModelRetryExhaustion },
    { name: 'planner execute chain', run: testPlannerExecuteChain },
    { name: 'planner execute concurrent wave', run: testPlannerExecuteConcurrentWave },
    { name: 'planner execute conflict policy fail', run: testPlannerExecuteConflictPolicyFail },
    { name: 'planner execute conflict domain fail', run: testPlannerExecuteConflictDomainFail },
    { name: 'planner execute conflict domain serial', run: testPlannerExecuteConflictDomainSerial },
    { name: 'planner execute degraded optional docs', run: testPlannerExecuteDegradedOptionalDocs },
    { name: 'planner execute degraded does not unblock verify', run: testPlannerExecuteDegradedDoesNotUnblockVerify },
    { name: 'planner execute rolling window append', run: testPlannerExecuteRollingWindowAppend },
    { name: 'planner execute rolling append rejects done step mutation', run: testPlannerExecuteRollingAppendRejectsDoneStepMutation },
    { name: 'planner execute feedback writes undeclared changes', run: testPlannerExecuteFeedbackWritesUndeclaredChanges },
    { name: 'planner execute feedback triggers replan', run: testPlannerExecuteFeedbackTriggersReplan },
    { name: 'planner execute affected subgraph calculator', run: testPlannerExecuteAffectedSubgraphCalculator },
    { name: 'planner append active lock conflict', run: testPlannerAppendActiveLockConflict },
    { name: 'planner execute retry recovery', run: testPlannerExecuteRetryRecovery },
    { name: 'planner execute fallback model', run: testPlannerExecuteFallbackModel },
    { name: 'planner execute graph fallback', run: testPlannerExecuteGraphFallback },
    { name: 'planner execute local replan', run: testPlannerExecuteLocalReplan },
    { name: 'planner execute rejects invalid local replan', run: testPlannerExecuteRejectsInvalidLocalReplan },
    { name: 'planner execute rejects lock-incompatible local replan', run: testPlannerExecuteRejectsLockIncompatibleLocalReplan },
    { name: 'planner execute blocked dependents', run: testPlannerExecuteBlockedDependents },
  ];
}

async function testPlannerGraphAndWaves(): Promise<void> {
  const graph = buildExecutionGraph({
    version: '1',
    revision: 1,
    summary: 'graph fixture',
    steps: [
      { id: 'step-1', title: 'Update math', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
      { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
      { id: 'step-3', title: 'Retouch math docs', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
    ],
  });

  assert.equal(graph.edges.some((edge) => edge.type === 'conflict' && edge.from === 'step-1' && edge.to === 'step-3'), true);
  assert.deepEqual(graph.waves.map((wave) => wave.stepIds), [['step-1', 'step-2'], ['step-3']]);

  const selectedVerify = selectExecutionWave(
    [
      { id: 'step-1', title: 'Update math', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
      { id: 'step-2', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
    ],
    {
      ...graph,
      waves: [{ index: 0, stepIds: ['step-1', 'step-2'] }],
    },
    2,
    (step) => (step.kind === 'verify' ? 'verify' : 'subagent'),
  );
  assert.deepEqual(selectedVerify.map((step) => step.id), ['step-2']);

  const restrictedWrite = selectExecutionWave(
    [
      { id: 'step-4', title: 'Unknown write', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [] },
      { id: 'step-5', title: 'Known write', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
    ],
    {
      ...graph,
      waves: [{ index: 0, stepIds: ['step-4', 'step-5'] }],
    },
    2,
    () => 'subagent',
  );
  assert.deepEqual(restrictedWrite.map((step) => step.id), ['step-4']);

  const conflictMessage = detectPendingConflictFailure(
    {
      version: '1',
      revision: 1,
      summary: 'graph fixture',
      steps: [
        { id: 'step-1', title: 'Update math', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
        { id: 'step-3', title: 'Retouch math docs', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
      ],
    },
    buildExecutionGraph({
      version: '1',
      revision: 1,
      summary: 'conflict fixture',
      steps: [
        { id: 'step-1', title: 'Update math', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
        { id: 'step-3', title: 'Retouch math docs', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
      ],
    }),
  );
  assert.match(conflictMessage ?? '', /step-1/);

  const blocked = annotateBlockedDependents(
    {
      version: '1',
      revision: 1,
      summary: 'blocked fixture',
      steps: [
        { id: 'step-1', title: 'Update math', status: 'FAILED', kind: 'code', attempts: 1, dependencies: [], children: [] },
        { id: 'step-2', title: 'Update tests', status: 'PENDING', kind: 'test', attempts: 0, dependencies: ['step-1'], children: [] },
      ],
    },
    new Set(['step-1']),
    (plan, stepId, updates) => ({
      ...plan,
      steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
    }),
  );
  assert.equal(blocked.steps[1]?.executionState, 'blocked');
  assert.match(blocked.steps[1]?.lastError ?? '', /step-1/);
}

async function testPlannerGraphFallbackReadiness(): Promise<void> {
  const plan = {
    version: '1' as const,
    revision: 1,
    summary: 'fallback graph fixture',
    steps: [
      { id: 'step-1', title: 'Primary implementation', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'], fileScope: ['src/math.js'] },
      { id: 'step-1-fallback', title: 'Fallback implementation', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'] },
      { id: 'step-2', title: 'Downstream verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
    ],
  };
  const graph = buildExecutionGraph(plan);
  assert.equal(graph.nodes.find((node) => node.stepId === 'step-1')?.fallbackStepIds.includes('step-1-fallback'), true);
  assert.equal(graph.edges.some((edge) => edge.type === 'fallback' && edge.from === 'step-1' && edge.to === 'step-1-fallback'), true);
  assert.deepEqual(graph.waves.map((wave) => wave.stepIds), [['step-1'], ['step-1-fallback', 'step-2']]);

  const pendingState = {
    version: '1' as const,
    revision: 1,
    phase: 'PATCHING' as const,
    outcome: 'RUNNING' as const,
    currentStepId: null,
    activeStepIds: [],
    readyStepIds: [],
    completedStepIds: [],
    failedStepIds: [],
    blockedStepIds: [],
    invalidResponseAttempts: 0,
    message: 'ready',
    consistencyErrors: [],
  };
  assert.deepEqual(getReadyStepIds(plan, pendingState, graph), ['step-1']);

  const failedPlan = {
    ...plan,
    steps: plan.steps.map((step) => (step.id === 'step-1' ? { ...step, status: 'FAILED' as const, executionState: 'failed' as const } : step)),
  };
  assert.deepEqual(getReadyStepIds(failedPlan, pendingState, graph), ['step-1-fallback']);

  const replacedPlan = {
    ...failedPlan,
    steps: failedPlan.steps.map((step) => (step.id === 'step-1-fallback' ? { ...step, status: 'DONE' as const, executionState: 'done' as const } : step)),
  };
  assert.deepEqual(getReadyStepIds(replacedPlan, pendingState, graph), ['step-2']);
}

async function testPlannerExecutionLocks(): Promise<void> {
  let locks = createExecutionLockTable(1);
  locks = acquireWriteLocks(locks, 'step-1', ['src/math.js'], 1);
  assert.doesNotThrow(() => assertStepCanWrite(locks, 'step-1', 'src/math.js'));
  locks = downgradeToGuardedRead(locks, 'step-1', ['src/math.js'], 1);
  assert.throws(() => assertStepCanWrite(locks, 'step-1', 'src/math.js'));
  locks = transferWriteOwnership(locks, 'step-1', 'step-2', ['src/math.js'], 1);
  assert.doesNotThrow(() => assertStepCanWrite(locks, 'step-2', 'src/math.js'));

  const transferred = prepareLockTableForStep(
    downgradeToGuardedRead(acquireWriteLocks(createExecutionLockTable(2), 'step-1', ['src/math.js'], 2), 'step-1', ['src/math.js'], 2),
    {
      version: '1',
      revision: 2,
      summary: 'lock transfer fixture',
      steps: [
        { id: 'step-1', title: 'Update math', status: 'DONE', kind: 'code', attempts: 1, fileScope: ['src/math.js'], dependencies: [], children: [] },
        { id: 'step-2', title: 'Retest math', status: 'PENDING', kind: 'test', attempts: 0, fileScope: ['src/math.js'], dependencies: ['step-1'], children: [] },
      ],
    },
    { id: 'step-2', title: 'Retest math', status: 'PENDING', kind: 'test', attempts: 0, fileScope: ['src/math.js'], dependencies: ['step-1'], children: [] },
    ['src/math.js'],
  );
  assert.doesNotThrow(() => assertStepCanWrite(transferred, 'step-2', 'src/math.js'));
}

async function testPlannerPlanAppendValidation(): Promise<void> {
  const previousPlan = {
    version: '1' as const,
    revision: 1,
    summary: 'partial plan',
    isPartial: true,
    steps: [
      { id: 'step-1', title: 'Fix math', status: 'DONE' as const, kind: 'code' as const, attempts: 1, fileScope: ['src/math.js'], accessMode: 'write' as const, dependencies: [], children: [] },
    ],
  };
  const appendPlan = {
    version: '1' as const,
    revision: 2,
    summary: 'finish plan',
    isPartial: false,
    steps: [
      { id: 'step-2', title: 'Run verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
    ],
  };
  const validation = validatePlanAppend(previousPlan, appendPlan);
  assert.equal(validation.ok, true);
  const merged = mergePlanAppend(previousPlan, appendPlan);
  assert.equal(merged.revision, 2);
  assert.equal(merged.isPartial, false);
  assert.deepEqual(merged.steps.map((step) => step.id), ['step-1', 'step-2']);

  const invalidAppend = {
    ...appendPlan,
    steps: [
      { id: 'step-1', title: 'Rewrite done step', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [] },
    ],
  };
  const invalidValidation = validatePlanAppend(previousPlan, invalidAppend);
  assert.equal(invalidValidation.ok, false);
  assert.match(invalidValidation.errors.join('; '), /redefine existing step step-1/);
}

async function testPlannerRuntimeHelpers(): Promise<void> {
  const request = buildPlannerRequestArtifact(
    {
      prompt: 'Add retries',
      explicitFiles: [],
      pastedSnippets: [],
    },
    '/tmp/session',
    {
      request: {
        promptHistory: ['Initial request'],
        explicitFiles: ['src/math.js'],
        pastedSnippets: ['const x = 1;'],
        resumedFrom: null,
      },
      plan: {
        version: '1',
        revision: 1,
        summary: 'prior plan',
        steps: [],
      },
      state: initializePlannerState(undefined, 1, '', false),
    },
  );
  assert.deepEqual(request.promptHistory, ['Initial request', 'Add retries']);
  assert.deepEqual(request.explicitFiles, ['src/math.js']);
  assert.equal(request.resumedFrom, '/tmp/session');

  assert.equal(classifyPlannerStep({ id: 'verify', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: [], children: [] }), 'verify');
  assert.equal(classifyPlannerStep({ id: 'search', title: 'Search files', status: 'PENDING', kind: 'search', attempts: 0, dependencies: [], children: [] }), 'skip');
  assert.equal(classifyPlannerStep({ id: 'code', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [] }), 'subagent');

  const updatedPlan = updatePlannerStep(
    {
      version: '1',
      revision: 1,
      summary: 'update fixture',
      steps: [{ id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [] }],
    },
    'step-1',
    { executionState: 'done', status: 'DONE' },
  );
  assert.equal(updatedPlan.steps[0]?.status, 'DONE');
  assert.equal(updatedPlan.steps[0]?.executionState, 'done');

  assert.deepEqual(mapPlannerResult('DONE', '/tmp/session', 'ok'), { status: 'completed', sessionDir: '/tmp/session', message: 'ok' });
}

async function testPlannerExecutionStateMachineTransitions(): Promise<void> {
  assert.equal(transitionExecutionPhase('idle', { type: 'EXECUTION_INITIALIZED' }), 'planning');
  assert.equal(transitionExecutionPhase('planning', { type: 'LOCKS_ACQUIRED' }), 'locking');
  assert.equal(transitionExecutionPhase('locking', { type: 'WAVE_EXECUTED' }), 'executing_wave');
  assert.equal(transitionExecutionPhase('executing_wave', { type: 'WAVE_CONVERGED' }), 'converging');
  assert.equal(transitionExecutionPhase('converging', { type: 'EXECUTION_COMPLETED' }), 'done');
  assert.equal(transitionExecutionPhase('executing_wave', { type: 'VERIFY_STEP_FAILED' }), 'failed');
  assert.equal(transitionExecutionPhase('recovering', { type: 'WAVE_REPLANNED' }), 'recovering');
  assert.equal(transitionExecutionPhase('executing_wave', { type: 'FALLBACK_ACTIVATED' }), 'recovering');

  assert.throws(() => transitionExecutionPhase('done', { type: 'EXECUTION_INITIALIZED' }), /Invalid execution transition/);
  assert.throws(() => transitionExecutionPhase('failed', { type: 'WAVE_CONVERGED' }), /Invalid execution transition/);
  assert.throws(() => transitionExecutionPhase('locking', { type: 'VERIFY_STEP_STARTED' }), /Invalid execution transition/);
}

async function testPlannerExecutionEventDispatch(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    const session = await createSession(config);
    const state = {
      version: '1' as const,
      revision: 1,
      phase: 'PATCHING' as const,
      outcome: 'RUNNING' as const,
      currentStepId: null,
      activeStepIds: [],
      readyStepIds: ['step-1'],
      completedStepIds: [],
      failedStepIds: [],
      blockedStepIds: [],
      invalidResponseAttempts: 0,
      message: 'ready',
      consistencyErrors: [],
    };
    const plan = {
      version: '1' as const,
      revision: 1,
      summary: 'dispatch fixture',
      steps: [
        { id: 'step-1', title: 'Update notes', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'] },
      ],
    };
    const graph = buildExecutionGraph(plan);
    const locks = createExecutionLockTable(1);
    let executionState = createInitialExecutionState(state, 'serial');

    executionState = await dispatchExecutionEvent(session, graph, locks, executionState, { type: 'EXECUTION_INITIALIZED' }, {
      state,
      strategy: 'serial',
      currentWaveStepIds: [],
      lastCompletedWaveStepIds: [],
      epoch: 0,
    });
    assert.equal(executionState.executionPhase, 'planning');

    executionState = await dispatchExecutionEvent(session, graph, locks, executionState, { type: 'LOCKS_ACQUIRED' }, {
      state,
      strategy: 'serial',
      currentWaveStepIds: ['step-1'],
      lastCompletedWaveStepIds: [],
      epoch: 1,
    });
    assert.equal(executionState.executionPhase, 'locking');

    const persisted = JSON.parse(await readFile(path.join(session.dir, 'execution.state.json'), 'utf8')) as { executionPhase: string; currentWaveStepIds: string[]; epoch: number };
    assert.equal(persisted.executionPhase, 'locking');
    assert.deepEqual(persisted.currentWaveStepIds, ['step-1']);
    assert.equal(persisted.epoch, 1);

    await assert.rejects(
      () => dispatchExecutionEvent(session, graph, locks, executionState, { type: 'VERIFY_STEP_STARTED' }, {
        state,
        strategy: 'serial',
        currentWaveStepIds: ['step-1'],
        lastCompletedWaveStepIds: [],
        epoch: 1,
      }),
      /Invalid execution transition/,
    );
  });
}

async function testPlannerExecutionStrategies(): Promise<void> {
  const readySteps = [
    { id: 'step-1', title: 'Fix add', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
    { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
  ];
  const graph = buildExecutionGraph({
    version: '1',
    revision: 1,
    summary: 'strategy fixture',
    steps: readySteps,
  });

  const deterministic = getPlannerExecutionStrategy('deterministic');
  assert.deepEqual(deterministic.selectWave(readySteps, graph, 2, () => 'subagent').map((step) => step.id), ['step-1']);

  const aggressive = getPlannerExecutionStrategy('aggressive');
  assert.deepEqual(aggressive.selectWave(readySteps, graph, 1, () => 'subagent').map((step) => step.id), ['step-1', 'step-2']);

  const fail = getPlannerExecutionStrategy('fail');
  const conflictGraph = buildExecutionGraph({
    version: '1',
    revision: 1,
    summary: 'conflict fixture',
    steps: [
      { id: 'step-1', title: 'Fix add', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
      { id: 'step-2', title: 'Retouch same file', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
    ],
  }, 'fail');
  assert.match(fail.checkConflicts({ version: '1', revision: 1, summary: 'conflict fixture', steps: conflictGraph.nodes.map((node) => ({ id: node.stepId, title: node.title, status: 'PENDING', kind: node.kind, attempts: 0, relatedFiles: node.fileScope, fileScope: node.fileScope, dependencies: node.dependencies, children: [] })) }, conflictGraph) ?? '', /step-1/);
}

async function testPlannerConflictDomains(): Promise<void> {
  const graph = buildExecutionGraph({
    version: '1',
    revision: 1,
    summary: 'domain conflict fixture',
    steps: [
      { id: 'step-1', title: 'Update API implementation', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/api.ts'], fileScope: ['src/api.ts'], conflictDomains: ['api-contract'], dependencies: [], children: [] },
      { id: 'step-2', title: 'Update API tests', status: 'PENDING', kind: 'test', attempts: 0, relatedFiles: ['tests/api.test.ts'], fileScope: ['tests/api.test.ts'], conflictDomains: ['api-contract'], dependencies: [], children: [] },
      { id: 'step-3', title: 'Update theme docs', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['docs/theme.md'], fileScope: ['docs/theme.md'], conflictDomains: ['css-theme'], dependencies: [], children: [] },
    ],
  });

  const domainEdge = graph.edges.find((edge) => edge.type === 'conflict' && edge.from === 'step-1' && edge.to === 'step-2');
  assert.equal(domainEdge?.reason, 'conflict_domain');
  assert.equal(domainEdge?.domain, 'api-contract');
  assert.equal(graph.edges.some((edge) => edge.type === 'conflict' && edge.to === 'step-3'), false);
}

async function testPlannerReplanProposalValidation(): Promise<void> {
  const previousPlan = {
    version: '1' as const,
    revision: 1,
    summary: 'previous plan',
    steps: [
      { id: 'step-0', title: 'Inspect math', status: 'DONE' as const, kind: 'search' as const, attempts: 1, executionState: 'done' as const, dependencies: [], children: [], relatedFiles: ['src/math.js'] },
      { id: 'step-1', title: 'Fix add', status: 'FAILED' as const, kind: 'code' as const, attempts: 1, dependencies: ['step-0'], children: [], fileScope: ['src/math.js'] },
      { id: 'step-2', title: 'Verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
      { id: 'step-3', title: 'Unrelated docs update', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'] },
    ],
  };
  const proposedPlan = {
    version: '1' as const,
    revision: 2,
    summary: 'valid replan',
    steps: [
      { id: 'step-0', title: 'Inspect math', status: 'DONE' as const, kind: 'search' as const, attempts: 0, dependencies: [], children: [], relatedFiles: ['src/math.js'] },
      { id: 'step-1', title: 'Retry add fix', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: ['step-0'], children: [], fileScope: ['src/math.js'] },
      { id: 'step-2', title: 'Verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
      { id: 'step-3', title: 'Unrelated docs update', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'] },
    ],
  };

  const scope = collectReplanScope(previousPlan, 'step-1');
  assert.deepEqual([...scope.allowedStepIds].sort(), ['step-1', 'step-2']);
  assert.deepEqual([...scope.protectedStepIds].sort(), ['step-3']);

  const merged = mergeReplanProposal(previousPlan, proposedPlan, 'step-1', 'original failure');
  assert.equal(merged.validation.ok, true);
  assert.equal(merged.plan.revision, 2);
  assert.equal(merged.plan.steps.find((step) => step.id === 'step-0')?.attempts, 1);
  assert.equal(merged.plan.steps.find((step) => step.id === 'step-0')?.executionState, 'done');
  assert.equal(merged.plan.steps.find((step) => step.id === 'step-1')?.status, 'PENDING');
  assert.equal(merged.plan.steps.find((step) => step.id === 'step-1')?.failureKind, 'replan_required');
  assert.match(merged.plan.steps.find((step) => step.id === 'step-1')?.lastError ?? '', /original failure/);

  const invalidPlan = {
    ...proposedPlan,
    steps: proposedPlan.steps.map((step) => (step.id === 'step-3' ? { ...step, title: 'Mutated protected pending step' } : step)),
  };
  const validation = validateReplanProposal(previousPlan, invalidPlan, 'step-1');
  assert.equal(validation.ok, false);
  assert.equal(validation.errors.some((error) => /protected step step-3 title outside replan scope/.test(error)), true);
}

async function testPlannerReplanLockCompatibility(): Promise<void> {
  const previousPlan = {
    version: '1' as const,
    revision: 2,
    summary: 'lock compatibility plan',
    steps: [
      { id: 'step-1', title: 'Fix add', status: 'FAILED' as const, kind: 'code' as const, attempts: 1, dependencies: [], children: [], fileScope: ['src/math.js'] },
      { id: 'step-2', title: 'Verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
      { id: 'step-9', title: 'Earlier notes writer', status: 'DONE' as const, kind: 'docs' as const, attempts: 1, executionState: 'done' as const, dependencies: [], children: [], fileScope: ['src/notes.txt'] },
    ],
  };
  const proposedPlan = {
    ...previousPlan,
    revision: 3,
    steps: [
      { id: 'step-1', title: 'Retry add by editing notes', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'], accessMode: 'write' as const },
      { id: 'step-2', title: 'Verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], children: [] },
      { id: 'step-9', title: 'Earlier notes writer', status: 'DONE' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'] },
    ],
  };
  const lockTable = downgradeToGuardedRead(acquireWriteLocks(createExecutionLockTable(2), 'step-9', ['src/notes.txt'], 2), 'step-9', ['src/notes.txt'], 2);
  const lockErrors = validateReplanLockCompatibility(previousPlan, proposedPlan, 'step-1', lockTable);
  assert.equal(lockErrors.some((error) => /step-1 cannot write locked path src\/notes.txt; current owner is step-9/.test(error)), true);

  const transferablePlan = {
    ...proposedPlan,
    steps: proposedPlan.steps.map((step) => (step.id === 'step-9' ? { ...step, ownershipTransfers: ['step-1'] } : step)),
  };
  assert.deepEqual(validateReplanLockCompatibility(previousPlan, transferablePlan, 'step-1', lockTable), []);
}

async function testPlannerExecuteEntryHelper(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    const session = await createSession(config);
    const result = await executePlannerPlan(
      config,
      new Map<string, ModelProvider>(),
      session,
      {
        promptHistory: ['Execute planner helper'],
        explicitFiles: [],
        pastedSnippets: [],
        resumedFrom: null,
      },
      {
        version: '1',
        revision: 1,
        summary: 'execute helper fixture',
        steps: [
          { id: 'step-1', title: 'Search files only', status: 'PENDING', kind: 'search', attempts: 0, dependencies: [], children: [] },
        ],
      },
      {
        version: '1',
        revision: 1,
        phase: 'PLANNING',
        outcome: 'DONE',
        currentStepId: null,
        activeStepIds: [],
        readyStepIds: ['step-1'],
        completedStepIds: [],
        failedStepIds: [],
        blockedStepIds: [],
        invalidResponseAttempts: 0,
        message: 'planned',
        consistencyErrors: [],
      },
      {
        classifyPlannerStep: (step) => (step.kind === 'search' ? 'skip' : 'subagent'),
        updatePlannerStep: (plan, stepId, updates) => ({
          ...plan,
          steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
        }),
      },
    );

    assert.equal(result.state.outcome, 'DONE');
    assert.equal(result.plan.steps[0]?.status, 'DONE');
    assert.equal(result.plan.steps[0]?.executionState, 'done');
    const executionState = JSON.parse(await readFile(path.join(session.dir, 'execution.state.json'), 'utf8')) as { executionPhase: string; strategy: string; epoch: number };
    assert.equal(executionState.executionPhase, 'done');
    assert.equal(executionState.strategy, 'serial');
    assert.equal(executionState.epoch, 1);
  });
}

async function testPlannerVerifyHelper(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.verifier.enabled = true;
    config.verifier.allowDiscovery = false;
    config.verifier.commands = ['true'];
    const session = await createSession(config);
    const result = await executePlannerVerifyStep(
      config,
      new Map<string, ModelProvider>(),
      session,
      {
        promptHistory: ['Run final verify'],
        explicitFiles: ['src/math.js'],
        pastedSnippets: [],
        resumedFrom: null,
      },
      {
        version: '1',
        revision: 1,
        summary: 'verify helper fixture',
        steps: [
          { id: 'verify-step', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: [], children: [] },
        ],
      },
      {
        version: '1',
        revision: 1,
        phase: 'PATCHING',
        outcome: 'RUNNING',
        currentStepId: null,
        activeStepIds: [],
        readyStepIds: ['verify-step'],
        completedStepIds: [],
        failedStepIds: [],
        blockedStepIds: [],
        invalidResponseAttempts: 0,
        message: 'ready',
        consistencyErrors: [],
      },
      { id: 'verify-step', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: [], children: [] },
      ['src/math.js'],
      createExecutionLockTable(1),
      {
        executePlannerSubtaskWithRecovery: async () => {
          throw new Error('verify repair should not run on successful verifier');
        },
        updatePlannerStep: (plan, stepId, updates) => ({
          ...plan,
          steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
        }),
      },
    );

    assert.equal(result.stop, false);
    assert.equal(result.plan.steps[0]?.status, 'DONE');
    assert.deepEqual(result.changedFiles, ['src/math.js']);
    const verifyArtifact = JSON.parse(await readFile(path.join(session.dir, 'subtask.verify-step.verify.json'), 'utf8')) as { success: boolean };
    assert.equal(verifyArtifact.success, true);
  });
}

async function testPlannerSubtaskRecoveryHelper(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    const session = await createSession(config);
    await assert.rejects(
      () => executePlannerSubtaskWithRecovery(
        config,
        new Map<string, ModelProvider>(),
        session,
        {
          promptHistory: ['Fix math'],
          explicitFiles: ['src/math.js'],
          pastedSnippets: [],
          resumedFrom: null,
        },
        {
          version: '1',
          revision: 1,
          summary: 'subtask recovery fixture',
          steps: [
            { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'] },
          ],
        },
        {
          version: '1',
          revision: 1,
          phase: 'PATCHING',
          outcome: 'RUNNING',
          currentStepId: null,
          activeStepIds: [],
          readyStepIds: ['step-1'],
          completedStepIds: [],
          failedStepIds: [],
          blockedStepIds: [],
          invalidResponseAttempts: 0,
          message: 'ready',
          consistencyErrors: [],
        },
        { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'] },
        'Fix src/math.js',
        ['src/math.js'],
        false,
        false,
        createExecutionLockTable(1),
        false,
        (plan, stepId, updates) => ({
          ...plan,
          steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)),
        }),
      ),
      /not available/i,
    );
  });
}

async function testPlannerReadOnlyFlow(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    const registry = createPlannerRegistry(config, policy);
    const provider = new SequenceProvider(
      [
        JSON.stringify({
          type: 'plan',
          plan: {
            version: '1',
            summary: 'Refactor the router module and add tests.',
            steps: [
              {
                id: 'step-1',
                title: '查找 router 相关文件',
                status: 'PENDING',
                kind: 'search',
                details: '定位 router/register/export/test 相关实现和入口。',
                dependencies: [],
                children: [],
              },
              {
                id: 'step-2',
                title: '修改路由逻辑',
                status: 'PENDING',
                kind: 'code',
                dependencies: ['step-1'],
                children: [],
              },
              {
                id: 'step-3',
                title: '更新测试',
                status: 'PENDING',
                kind: 'test',
                dependencies: ['step-2'],
                children: [],
              },
              {
                id: 'step-4',
                title: '执行 verify',
                status: 'PENDING',
                kind: 'verify',
                dependencies: ['step-3'],
                children: [],
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'plan_update',
          stepId: 'step-1',
          status: 'SEARCHING',
          message: 'Searching router and register files.',
          relatedFiles: ['src/router.js', 'src/register-routes.js'],
        }),
        JSON.stringify({
          type: 'tool_call',
          tool: 'search_text',
          input: {
            pattern: 'registerRoute|router',
            pathPattern: 'src/**/*.js',
          },
        }),
        JSON.stringify({
          type: 'plan_update',
          stepId: 'step-1',
          status: 'DONE',
          message: 'Identified the router implementation and registration entry points.',
          relatedFiles: ['src/router.js', 'src/register-routes.js', 'src/server.js'],
        }),
        JSON.stringify({
          type: 'final',
          outcome: 'DONE',
          message: 'Plan captured and ready for execution.',
          summary: '1. 查找 router 相关文件 2. 修改路由逻辑 3. 更新测试 4. 执行 verify',
        }),
      ],
      (request, index) => {
        if (index === 0) {
          assert.match(request.systemPrompt ?? '', /read-only/i);
          assert.doesNotMatch(request.messages[0]?.content ?? '', /run_shell/);
          assert.match(request.messages[0]?.content ?? '', /\[Pasted ~1 lines #1\]/);
          assert.match(request.messages[0]?.content ?? '', /Subtask context packet template:/);
        }
      },
    );

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '重构路由模块并补测试',
      explicitFiles: [],
      pastedSnippets: ['registerRoute(router, "/health", handler);'],
    });

    assert.equal(result.status, 'completed');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as {
      revision: number;
      summary: string;
      steps: Array<{ id: string; status: string; relatedFiles?: string[] }>;
    };
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as {
      outcome: string;
      phase: string;
      message: string;
    };
    const contextPacket = JSON.parse(await readFile(path.join(result.sessionDir, 'planner.context.packet.json'), 'utf8')) as {
      constraints: { readOnly: boolean; allowedTools: string[] };
      queryTerms: string[];
    };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    const toolsLog = await readFile(path.join(result.sessionDir, 'tools.jsonl'), 'utf8');

    assert.equal(plan.revision, 1);
    assert.match(plan.summary, /1\. 查找 router/);
    assert.equal(plan.steps[0]?.status, 'DONE');
    assert.deepEqual(plan.steps[0]?.relatedFiles, ['src/router.js', 'src/register-routes.js', 'src/server.js']);
    assert.equal(state.outcome, 'DONE');
    assert.equal(contextPacket.constraints.readOnly, true);
    assert.deepEqual(contextPacket.constraints.allowedTools, ['read_file', 'list_files', 'search_text', 'git_status', 'git_log', 'git_show', 'git_diff', 'git_diff_base']);
    assert.ok(contextPacket.queryTerms.includes('router'));
    assert.match(events, /planner_started/);
    assert.match(events, /plan_step_updated/);
    assert.match(plannerLog, /"type":"plan_snapshot"/);
    assert.match(plannerLog, /"type":"planner_terminal"/);
    assert.match(toolsLog, /search_text/);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /BUG_MARKER/);
  });
}

async function testPlannerInvalidRetryAndResume(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    const provider = new SequenceProvider([
      JSON.stringify({
        type: 'patch',
        patch: {
          version: '1',
          summary: 'should fail in planner mode',
          operations: [],
        },
      }),
      JSON.stringify({
        type: 'plan',
        plan: {
          version: '1',
          summary: 'Need more information before planning the route refactor.',
          steps: [
            {
              id: 'step-1',
              title: 'Clarify target API surface',
              status: 'PENDING',
              kind: 'search',
              dependencies: [],
              children: [],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'final',
        outcome: 'NEEDS_INPUT',
        message: 'Need the target route export surface before planning the refactor.',
      }),
    ]);

    const first = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '重构路由模块并补测试',
      explicitFiles: [],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'needs_input');
    const firstEvents = await readFile(path.join(first.sessionDir, 'plan.events.jsonl'), 'utf8');
    const firstPlannerLog = await readFile(path.join(first.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.match(firstEvents, /planner_invalid_output/);
    assert.match(firstPlannerLog, /"type":"invalid_response"/);
    const firstState = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.state.json'), 'utf8')) as {
      revision: number;
      outcome: string;
    };
    assert.equal(firstState.revision, 1);
    assert.equal(firstState.outcome, 'NEEDS_INPUT');

    const resumedProvider = new SequenceProvider([
      (request) => {
        assert.match(request.messages[0]?.content ?? '', /Current plan:/);
        assert.match(request.messages[0]?.content ?? '', /Additional planner input:/);
        return JSON.stringify({
          type: 'plan',
          plan: {
            version: '1',
            summary: 'Replanned route refactor with clarified export surface.',
            steps: [
              {
                id: 'step-1',
                title: '查找 router 相关文件',
                status: 'DONE',
                kind: 'search',
                dependencies: [],
                children: [],
              },
              {
                id: 'step-2',
                title: '修改路由逻辑',
                status: 'PENDING',
                kind: 'code',
                dependencies: ['step-1'],
                children: [],
              },
            ],
          },
        });
      },
      JSON.stringify({
        type: 'final',
        outcome: 'DONE',
        message: 'Replanned with the new route export information.',
      }),
    ]);

    const resumed = await runPlanner(config, new Map([['stub', resumedProvider]]), registry, {
      prompt: '新的输入：还需要保留现有导出结构。',
      explicitFiles: [],
      pastedSnippets: [],
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.sessionDir, first.sessionDir);
    const requestArtifact = JSON.parse(await readFile(path.join(resumed.sessionDir, 'planner.request.json'), 'utf8')) as {
      promptHistory: string[];
    };
    const finalPlan = JSON.parse(await readFile(path.join(resumed.sessionDir, 'plan.json'), 'utf8')) as {
      revision: number;
      summary: string;
    };
    const finalEvents = await readFile(path.join(resumed.sessionDir, 'plan.events.jsonl'), 'utf8');

    assert.deepEqual(requestArtifact.promptHistory, ['重构路由模块并补测试', '新的输入：还需要保留现有导出结构。']);
    assert.equal(finalPlan.revision, 2);
    assert.match(finalPlan.summary, /Replanned/);
    assert.match(finalEvents, /planner_replanned/);
  });
}

async function testPlannerExecuteResumeFromArtifacts(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const content = request.messages[0]?.content ?? '';
        if (!content.includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Resume execution after interruption.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Resume execution after interruption.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(first.status, 'completed');
    const simulatedInterruptedPlan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as {
      version: '1';
      revision: number;
      summary: string;
      steps: Array<Record<string, unknown>>;
    };
    simulatedInterruptedPlan.steps = simulatedInterruptedPlan.steps.map((step) => {
      if (step.id !== 'step-1') {
        return step;
      }
      return {
        ...step,
        status: 'PENDING',
        executionState: 'running',
        lastError: 'Interrupted during executing_wave; resuming through recovery path.',
      };
    });
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(simulatedInterruptedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({
      version: '1',
      revision: 1,
      phase: 'PATCHING',
      outcome: 'RUNNING',
      currentStepId: 'step-1',
      activeStepIds: ['step-1'],
      readyStepIds: [],
      completedStepIds: [],
      failedStepIds: [],
      blockedStepIds: ['step-2'],
      invalidResponseAttempts: 0,
      message: 'Interrupted during executing_wave; resuming through recovery path.',
      consistencyErrors: [],
    }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({
      version: '1',
      revision: 1,
      executionPhase: 'executing_wave',
      plannerPhase: 'PATCHING',
      outcome: 'RUNNING',
      activeStepIds: ['step-1'],
      readyStepIds: [],
      completedStepIds: [],
      failedStepIds: [],
      blockedStepIds: ['step-2'],
      currentWaveStepIds: ['step-1'],
      lastCompletedWaveStepIds: [],
      strategy: 'serial',
      epoch: 2,
      currentStepId: 'step-1',
      message: 'Interrupted during executing_wave; resuming through recovery path.',
      recoveryReason: 'Interrupted during executing_wave; resuming through recovery path.',
    }, null, 2), 'utf8');

    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a - b; // BUG_MARKER\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { executionPhase: string; lastCompletedWaveStepIds: string[]; strategy: string; epoch: number };
    assert.equal(resumedExecutionState.executionPhase, 'done');
    assert.equal(resumedExecutionState.strategy, 'serial');
    assert.equal(resumedExecutionState.epoch >= 1, true);
    assert.ok(resumedExecutionState.lastCompletedWaveStepIds.length >= 1);
  });
}

async function testPlannerModelRetry(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    config.session.modelRetryAttempts = 3;
    config.session.modelRetryDelayMs = 1;
    const provider = new FlakyProvider(2, () => JSON.stringify({
      type: 'final',
      outcome: 'DONE',
      message: 'Planner completed after retrying transient rate limits.',
      summary: 'retry ok',
    }));

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '为路由模块生成一个简短计划',
      explicitFiles: ['src/router.js'],
      pastedSnippets: [],
    });

    assert.equal(result.status, 'completed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.match(events, /planner_model_retry/);
    assert.match(plannerLog, /"type":"model_retry"/);
  });
}

async function testPlannerModelRetryExhaustion(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    config.session.modelRetryAttempts = 2;
    config.session.modelRetryDelayMs = 1;
    const provider = new FlakyProvider(10, () => JSON.stringify({ type: 'final', outcome: 'DONE', message: 'unreachable' }));

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '为路由模块生成一个简短计划',
      explicitFiles: ['src/router.js'],
      pastedSnippets: [],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /failed after 2 retries/i);
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { outcome: string; message: string };
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.equal(state.outcome, 'FAILED');
    assert.match(state.message, /429|failed after 2 retries/i);
    assert.match(plannerLog, /"type":"model_failure"/);
  });
}

async function testPlannerExecuteChain(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Fix the add bug and run final verify.',
              steps: [
                {
                  id: 'step-1',
                  title: 'Inspect math bug',
                  status: 'PENDING',
                  kind: 'search',
                  details: 'Review src/math.js and tests/check-math.js.',
                  relatedFiles: ['src/math.js', 'tests/check-math.js'],
                  dependencies: [],
                  children: [],
                },
                {
                  id: 'step-2',
                  title: 'Fix the add implementation',
                  status: 'PENDING',
                  kind: 'code',
                  details: 'Change add so it returns a + b.',
                  relatedFiles: ['src/math.js'],
                  dependencies: ['step-1'],
                  children: [],
                },
                {
                  id: 'step-3',
                  title: 'Run final verify',
                  status: 'PENDING',
                  kind: 'verify',
                  details: 'Run the project verifier.',
                  dependencies: ['step-2'],
                  children: [],
                },
              ],
            },
          });
        }

        return JSON.stringify({
          type: 'final',
          outcome: 'DONE',
          message: 'Plan complete',
          summary: 'Fix the add bug and run final verify.',
        });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { outcome: string; message: string };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const executionGraph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { waves: Array<{ stepIds: string[] }> };
    const executionLocks = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ path: string; mode: string }> };
    const verifyArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'subtask.step-3.verify.json'), 'utf8')) as { success: boolean };
    assert.equal(state.outcome, 'DONE');
    assert.match(state.message, /verifier passed|executed all subtasks/i);
    assert.equal(verifyArtifact.success, true);
    assert.match(events, /planner_execution_started/);
    assert.match(events, /"executor":"coder"/);
    assert.match(events, /"modelAlias":"code"/);
    assert.match(events, /subtask_completed/);
    assert.match(events, /planner_execution_finished/);
    assert.equal(executionGraph.waves.length >= 1, true);
    assert.equal(executionLocks.entries.some((entry) => entry.path === 'src/math.js' && entry.mode === 'guarded_read'), true);
  });
}

async function testPlannerExecuteConcurrentWave(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.maxConcurrentSubtasks = 2;
    let activeSubtasks = 0;
    let maxActiveSubtasks = 0;

    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Fix math and notes in one execution wave, then verify.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] },
                { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', details: 'Append a note confirming the fix.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], accessMode: 'write', dependencies: [], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier after both write steps complete.', dependencies: ['step-1', 'step-2'], children: [] },
              ],
            },
          });
        }

        return JSON.stringify({
          type: 'final',
          outcome: 'DONE',
          message: 'Plan complete',
          summary: 'Fix math and notes in one execution wave, then verify.',
        });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        activeSubtasks += 1;
        maxActiveSubtasks = Math.max(maxActiveSubtasks, activeSubtasks);
        await new Promise((resolve) => setTimeout(resolve, 25));
        try {
          const content = request.messages[0]?.content ?? '';
          if (content.includes('Update notes')) {
            return buildNotesOnlyStep(workspaceRoot);
          }
          return buildMathFixStep(workspaceRoot);
        } finally {
          activeSubtasks -= 1;
        }
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js、更新 src/notes.txt 并通过 verify',
      explicitFiles: ['src/math.js', 'src/notes.txt', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.ok(maxActiveSubtasks >= 2);
    const executionGraph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { waves: Array<{ stepIds: string[] }> };
    const executionLocks = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ path: string; mode: string }> };
    assert.deepEqual(executionGraph.waves[0]?.stepIds, ['step-1', 'step-2']);
    assert.equal(executionLocks.entries.some((entry) => entry.path === 'src/math.js' && entry.mode === 'guarded_read'), true);
    assert.equal(executionLocks.entries.some((entry) => entry.path === 'src/notes.txt' && entry.mode === 'guarded_read'), true);
    assert.match(await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8'), /FIXED_NOTE/);
  });
}

async function testPlannerExecuteRollingWindowAppend(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.planningWindowWaves = 1;
    let plannerCalls = 0;
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        plannerCalls += 1;
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Fix the add bug in rolling windows.',
              isPartial: true,
              planningHorizon: { waveCount: 1 },
              nextPlanningTriggers: ['after step-2 succeeds'],
              steps: [
                { id: 'step-1', title: 'Inspect math bug', status: 'PENDING', kind: 'search', details: 'Review math and tests.', relatedFiles: ['src/math.js', 'tests/check-math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        if (!currentPlan.includes('"id": "step-3"') && !currentPlan.includes('"id":"step-3"')) {
          return JSON.stringify({
            type: 'plan_append',
            plan: {
              version: '1',
              summary: 'Append final verification wave.',
              isPartial: false,
              steps: [
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run the project verifier.', dependencies: ['step-2'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Rolling planning completed.' });
      }
      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }
      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.equal(plannerCalls >= 3, true);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const delta = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.delta.2.json'), 'utf8')) as { addedStepIds: string[]; planningWindowWaves: number; combinedIsPartial: boolean };
    assert.deepEqual(delta.addedStepIds, ['step-3']);
    assert.equal(delta.planningWindowWaves, 1);
    assert.equal(delta.combinedIsPartial, false);
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    assert.match(events, /planner_partial_execution_completed/);
    assert.match(events, /planner_execution_window_completed/);
    assert.match(events, /plan_appended/);
  });
}

async function testPlannerExecuteRollingAppendRejectsDoneStepMutation(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.routing.planningWindowWaves = 1;
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Initial partial plan.',
              isPartial: true,
              planningHorizon: { waveCount: 1 },
              steps: [
                { id: 'step-1', title: 'Planning note only', status: 'PENDING', kind: 'search', details: 'No-op planning step.', dependencies: [], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({
          type: 'plan_append',
          plan: {
            version: '1',
            summary: 'Invalid append.',
            isPartial: false,
            steps: [
              { id: 'step-1', title: 'Mutate done step', status: 'PENDING', kind: 'code', details: 'Should be rejected.', dependencies: [], children: [] },
            ],
          },
        });
      }
      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    await assert.rejects(
      runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
        prompt: '生成一个滚动规划并故意返回非法 append',
        explicitFiles: ['src/math.js'],
        pastedSnippets: [],
        executeSubtasks: true,
      }),
      /plan append is invalid/i,
    );
  });
}

async function testPlannerExecuteConflictPolicyFail(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.routing.maxConcurrentSubtasks = 2;
    config.routing.subtaskConflictPolicy = 'fail';

    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Two conflicting writes should fail under strict conflict policy.',
              steps: [
                { id: 'step-1', title: 'Edit math once', status: 'PENDING', kind: 'code', details: 'First edit.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] },
                { id: 'step-2', title: 'Edit math again', status: 'PENDING', kind: 'docs', details: 'Second conflicting edit.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Two conflicting writes should fail under strict conflict policy.' });
      }

      throw new Error('Subtask should not start when conflict policy is fail');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '对同一个文件做两次冲突写入',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /conflict detected/i);
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    assert.match(events, /subtask_conflict_detected/);
  });
}

async function testPlannerExecuteConflictDomainFail(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.routing.maxConcurrentSubtasks = 2;
    config.routing.subtaskConflictPolicy = 'fail';

    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Two different files still conflict on the same API contract.',
              steps: [
                { id: 'step-1', title: 'Update API implementation', status: 'PENDING', kind: 'code', details: 'Change the API implementation.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', conflictDomains: ['api-contract'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Update API tests', status: 'PENDING', kind: 'test', details: 'Change tests for the same API contract.', relatedFiles: ['tests/check-math.js'], fileScope: ['tests/check-math.js'], accessMode: 'write', conflictDomains: ['api-contract'], dependencies: [], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Two different files still conflict on the same API contract.' });
      }

      throw new Error('Subtask should not start when conflict-domain policy is fail');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '对同一个 API contract 做两处改动',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /conflict detected/i);
    const graph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { edges: Array<{ type: string; reason?: string; domain?: string }> };
    assert.equal(graph.edges.some((edge) => edge.type === 'conflict' && edge.reason === 'conflict_domain' && edge.domain === 'api-contract'), true);
  });
}

async function testPlannerExecuteConflictDomainSerial(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.maxConcurrentSubtasks = 2;
    config.routing.subtaskConflictPolicy = 'serial';

    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Serialize two domain-coupled writes, then verify.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', conflictDomains: ['api-contract'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Update API notes', status: 'PENDING', kind: 'docs', details: 'Append a note for the same API contract.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], accessMode: 'write', conflictDomains: ['api-contract'], dependencies: [], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier after both steps complete.', dependencies: ['step-1', 'step-2'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Serialize two domain-coupled writes, then verify.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        const content = request.messages[0]?.content ?? '';
        if (content.includes('Update API notes')) {
          return buildNotesOnlyStep(workspaceRoot);
        }
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '串行执行共享 API contract 的两个步骤',
      explicitFiles: ['src/math.js', 'src/notes.txt', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const graph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { edges: Array<{ from: string; to: string; type: string; reason?: string; domain?: string }> };
    assert.equal(graph.edges.some((edge) => edge.type === 'conflict' && edge.reason === 'conflict_domain' && edge.domain === 'api-contract'), true);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    assert.match(await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8'), /FIXED_NOTE/);
  });
}

async function testPlannerExecuteDegradedOptionalDocs(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Allow a docs step to degrade while core work still verifies.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] },
                { id: 'step-2', title: 'Update release notes', status: 'PENDING', kind: 'docs', details: 'Non-critical docs update that may fail.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], accessMode: 'write', failureTolerance: 'degrade', dependencies: [], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier after the code step.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Allow a docs step to degrade while core work still verifies.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        const content = request.messages[0]?.content ?? '';
        if (content.includes('Update release notes')) {
          throw new Error('Docs update failed intentionally');
        }
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '允许非关键文档步骤降级，但核心修复和 verify 仍需完成',
      explicitFiles: ['src/math.js', 'src/notes.txt', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { degradedStepIds?: string[]; message: string; outcome: string };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string; failureTolerance?: string }> };
    assert.equal(state.outcome, 'DONE');
    assert.deepEqual(state.degradedStepIds, ['step-2']);
    assert.match(state.message, /degraded steps: step-2/i);
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'FAILED');
    assert.match(events, /subtask_degraded/);
  });
}

async function testPlannerExecuteDegradedDoesNotUnblockVerify(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'A degraded core step must not unblock verify.',
              steps: [
                { id: 'step-1', title: 'Run flaky prerequisite test step', status: 'PENDING', kind: 'test', details: 'This step degrades but verify still depends on it.', relatedFiles: ['tests/check-math.js'], fileScope: ['tests/check-math.js'], accessMode: 'write', failureTolerance: 'degrade', dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify must not continue after a degraded dependency.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'A degraded core step must not unblock verify.' });
      }

      throw new Error('Flaky prerequisite failed intentionally');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '降级步骤不能放行 verify',
      explicitFiles: ['tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string; executionState?: string; failureKind?: string }> };
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'PENDING');
  });
}

async function testPlannerExecuteRetryRecovery(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.subtaskMaxAttempts = 2;
    let codeAttempts = 0;

    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        if ((request.messages[0]?.content ?? '').includes('Failed step:')) {
          throw new Error('Unexpected local replan request');
        }
        if (!(request.messages[0]?.content ?? '').includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Fix add after a transient subtask failure.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Fix add after a transient subtask failure.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        codeAttempts += 1;
        if (codeAttempts === 1) {
          throw new Error('Simulated transient coder failure');
        }
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; attempts: number; status: string }> };
    assert.match(events, /subtask_retry_scheduled/);
    assert.match(events, /subtask_retry_started/);
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.attempts, 2);
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'DONE');
  });
}

async function testPlannerExecuteFallbackModel(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.subtaskMaxAttempts = 1;
    config.routing.subtaskFallbackModel = 'cheap';
    config.models.code = { provider: 'primary', model: 'code-model' };
    config.models.cheap = { provider: 'fallback', model: 'fallback-model' };

    const primaryProvider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!(request.messages[0]?.content ?? '').includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Use fallback model for the code change.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Use fallback model for the code change.' });
      }

      throw new Error('Primary model failed for the step');
    });
    const fallbackProvider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }
      throw new Error('Unexpected fallback request');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['primary', primaryProvider], ['fallback', fallbackProvider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    assert.match(events, /subtask_fallback_started/);
    assert.match(events, /"modelAlias":"cheap"/);
  });
}

async function testPlannerExecuteGraphFallback(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.subtaskMaxAttempts = 1;
    delete config.routing.subtaskFallbackModel;
    config.routing.subtaskReplanOnFailure = false;
    let primaryAttempts = 0;

    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Use graph fallback when primary implementation fails.',
              steps: [
                { id: 'step-1', title: 'Primary impossible implementation', status: 'PENDING', kind: 'code', details: 'Try a primary implementation that will fail.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'] },
                { id: 'step-1-fallback', title: 'Fallback add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier after fallback replaces the failed primary step.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Use graph fallback when primary implementation fails.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        if (content.includes('Execute planner step: Primary impossible implementation')) {
          primaryAttempts += 1;
          throw new Error('Primary implementation failed intentionally');
        }
        if (content.includes('Execute planner step: Fallback add implementation')) {
          return buildMathFixStep(workspaceRoot);
        }
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '主实现失败时用 fallback 修复 src/math.js 并 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.equal(primaryAttempts >= 1, true);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string; executionState?: string }> };
    const graph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { edges: Array<{ from: string; to: string; type: string }> };
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.state.json'), 'utf8')) as { executionPhase: string };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(plan.steps.find((step) => step.id === 'step-1-fallback')?.status, 'DONE');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'DONE');
    assert.equal(graph.edges.some((edge) => edge.type === 'fallback' && edge.from === 'step-1' && edge.to === 'step-1-fallback'), true);
    assert.equal(state.executionPhase, 'done');
    assert.match(events, /subtask_fallback_activated/);
  });
}

async function testPlannerExecuteLocalReplan(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.subtaskMaxAttempts = 1;
    config.routing.subtaskFallbackModel = 'cheap';
    config.routing.subtaskReplanOnFailure = true;
    config.models.strong = { provider: 'primary', model: 'planner-model' };
    config.models.code = { provider: 'primary', model: 'code-model' };
    config.models.cheap = { provider: 'fallback', model: 'fallback-model' };

    const primaryProvider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (content.includes('Failed step:')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Replanned after coder failure.',
              steps: [
                { id: 'step-1', title: 'Retry add fix with minimal patch', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b after the earlier failure.', relatedFiles: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        if (!content.includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Initial plan before local replan.',
              steps: [
                { id: 'step-1', title: 'Do impossible thing', status: 'PENDING', kind: 'code', details: 'Do impossible thing before replanning.', relatedFiles: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Initial plan before local replan.' });
      }

      if (content.includes('Do impossible thing')) {
        throw new Error('Subtask could not complete with the original approach');
      }
      if (content.includes('returns a + b after the earlier failure')) {
        return buildMathFixStep(workspaceRoot);
      }
      throw new Error('Unexpected request during local replan');
    });
    const fallbackProvider = new BranchingProvider(async () => {
      throw new Error('Fallback model also failed before local replan');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['primary', primaryProvider], ['fallback', fallbackProvider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { lastReplanReason?: string };
    const proposal = JSON.parse(await readFile(path.join(result.sessionDir, 'replan.proposal.step-1.json'), 'utf8')) as { failedStepId: string; previousRevision: number; proposedRevision: number };
    assert.equal(proposal.failedStepId, 'step-1');
    assert.equal(proposal.previousRevision, 1);
    assert.equal(proposal.proposedRevision, 2);
    assert.match(events, /subtask_replan_proposed/);
    assert.match(events, /subtask_replan_merged/);
    assert.match(events, /subtask_replanned/);
    assert.match(state.lastReplanReason ?? '', /step-1/);
  });
}

async function testPlannerExecuteRejectsInvalidLocalReplan(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.routing.defaultModel = 'code';
    config.routing.subtaskMaxAttempts = 1;
    config.routing.subtaskReplanOnFailure = true;
    config.models.strong = { provider: 'primary', model: 'planner-model' };
    config.models.code = { provider: 'primary', model: 'code-model' };

    const primaryProvider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (content.includes('Failed step:')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Invalid replan mutates an out-of-scope pending step.',
              steps: [
                { id: 'step-0', title: 'Inspect math before editing', status: 'DONE', kind: 'search', details: 'Read the math file.', dependencies: [], children: [] },
                { id: 'step-1', title: 'Retry impossible change', status: 'PENDING', kind: 'code', details: 'Still impossible.', relatedFiles: ['src/math.js'], dependencies: ['step-0'], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
                { id: 'step-3', title: 'Mutated unrelated docs step', status: 'PENDING', kind: 'docs', details: 'This out-of-scope step should not change.', relatedFiles: ['src/notes.txt'], dependencies: [], children: [] },
              ],
            },
          });
        }
        if (!content.includes('"id": "step-0"') && !content.includes('"id":"step-0"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Initial plan with a completed search before failing code.',
              steps: [
                { id: 'step-0', title: 'Inspect math before editing', status: 'PENDING', kind: 'search', details: 'Read the math file.', dependencies: [], children: [] },
                { id: 'step-1', title: 'Do impossible thing', status: 'PENDING', kind: 'code', details: 'Do impossible thing before replanning.', relatedFiles: ['src/math.js'], dependencies: ['step-0'], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
                { id: 'step-3', title: 'Unrelated docs step', status: 'PENDING', kind: 'docs', details: 'Should stay outside local replan scope.', relatedFiles: ['src/notes.txt'], dependencies: [], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Initial plan with a completed search before failing code.' });
      }

      if (content.includes('Do impossible thing')) {
        throw new Error('Subtask could not complete with the original approach');
      }
      throw new Error('Unexpected request during invalid local replan fixture');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['primary', primaryProvider]]), plannerRegistry, {
      prompt: '模拟失败后返回非法 replan',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const proposal = JSON.parse(await readFile(path.join(result.sessionDir, 'replan.proposal.step-1.json'), 'utf8')) as { failedStepId: string };
    const rejection = JSON.parse(await readFile(path.join(result.sessionDir, 'replan.rejected.step-1.json'), 'utf8')) as { failedStepId: string; errors: string[] };
    assert.equal(proposal.failedStepId, 'step-1');
    assert.equal(rejection.failedStepId, 'step-1');
    assert.equal(rejection.errors.some((error) => /protected step step-3 title outside replan scope/.test(error)), true);
    assert.match(events, /subtask_replan_proposed/);
    assert.match(events, /subtask_replan_rejected/);
    assert.match(events, /subtask_replan_failed/);
  });
}

async function testPlannerExecuteRejectsLockIncompatibleLocalReplan(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.defaultModel = 'code';
    config.routing.subtaskMaxAttempts = 1;
    config.routing.subtaskReplanOnFailure = true;
    config.models.strong = { provider: 'primary', model: 'planner-model' };
    config.models.code = { provider: 'primary', model: 'code-model' };

    const primaryProvider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (content.includes('Failed step:')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Invalid replan conflicts with an existing notes lock.',
              steps: [
                { id: 'step-0', title: 'Inspect math before editing', status: 'DONE', kind: 'search', details: 'Read the math file.', dependencies: [], children: [] },
                { id: 'step-9', title: 'Earlier notes writer', status: 'DONE', kind: 'docs', details: 'Already touched notes.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
                { id: 'step-1', title: 'Retry by editing notes', status: 'PENDING', kind: 'code', details: 'This should be rejected by lock compatibility.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], accessMode: 'write', dependencies: ['step-0'], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        if (!content.includes('"id": "step-0"') && !content.includes('"id":"step-0"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Initial plan for lock-incompatible replan.',
              steps: [
                { id: 'step-0', title: 'Inspect math before editing', status: 'PENDING', kind: 'search', details: 'Read the math file.', dependencies: [], children: [] },
                { id: 'step-9', title: 'Write notes first', status: 'PENDING', kind: 'docs', details: 'Write notes so a lock exists.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], accessMode: 'write', dependencies: [], children: [] },
                { id: 'step-1', title: 'Do impossible thing', status: 'PENDING', kind: 'code', details: 'Do impossible thing before replanning.', relatedFiles: ['src/math.js'], dependencies: ['step-0'], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Initial plan for lock-incompatible replan.' });
      }

      if (content.includes('Execute planner step: Write notes first')) {
        return buildNotesOnlyStep(workspaceRoot);
      }
      if (content.includes('Execute planner step: Do impossible thing')) {
        throw new Error('Subtask could not complete with the original approach');
      }
      throw new Error('Unexpected request during lock-incompatible local replan fixture');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['primary', primaryProvider]]), plannerRegistry, {
      prompt: '模拟 local replan 与现有 notes 锁冲突',
      explicitFiles: ['src/math.js', 'src/notes.txt', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const rejection = JSON.parse(await readFile(path.join(result.sessionDir, 'replan.rejected.step-1.json'), 'utf8')) as { errors: string[] };
    assert.equal(rejection.errors.length > 0, true);
    assert.match(events, /subtask_replan_rejected/);
    assert.match(events, /subtask_replan_failed/);
  });
}

async function testPlannerExecuteBlockedDependents(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.routing.defaultModel = 'strong';
    config.routing.subtaskMaxAttempts = 1;
    config.routing.subtaskFallbackModel = 'cheap';
    config.routing.subtaskReplanOnFailure = false;
    config.models.strong = { provider: 'primary', model: 'planner-model' };
    config.models.code = { provider: 'primary', model: 'code-model' };
    config.models.cheap = { provider: 'fallback', model: 'fallback-model' };

    const primaryProvider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Show dependent steps blocked after a failed code step.',
              steps: [
                { id: 'step-1', title: 'Break the code step', status: 'PENDING', kind: 'code', details: 'Fail the first code step.', relatedFiles: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run dependent verify', status: 'PENDING', kind: 'verify', details: 'Should be blocked by step-1 failure.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Show dependent steps blocked after a failed code step.' });
      }

      throw new Error('Primary code step failed hard');
    });
    const fallbackProvider = new BranchingProvider(async () => {
      throw new Error('Fallback code step also failed');
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['primary', primaryProvider], ['fallback', fallbackProvider]]), plannerRegistry, {
      prompt: '模拟失败后阻断依赖 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'failed');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as {
      steps: Array<{ id: string; status: string; executionState?: string; failureKind?: string; details?: string }>;
    };
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'PENDING');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.executionState, 'blocked');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.failureKind, 'dependency');
    assert.match(plan.steps.find((step) => step.id === 'step-2')?.details ?? '', /Blocked by failed dependencies: step-1/);
  });
}

async function testPlannerExecuteFeedbackWritesUndeclaredChanges(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        return currentPlan.includes('"step-1"')
          ? JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Single step feedback.' })
          : JSON.stringify({
              type: 'plan', plan: { version: '1', summary: 'Feedback test.', steps: [
                { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', details: 'Fix add bug.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] }
              ] }
            });
      }
      if (request.metadata?.mode === 'mvp-json-loop') {
        const current = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
        const next = current.replace('return a - b;', 'return a + b;');
        return JSON.stringify({
          type: 'patch', patch: { version: '1', summary: 'Fix', operations: [{ type: 'replace_file', path: 'src/math.js', diff: 'Fix', oldText: current, newText: next }] }
        });
      }
      throw new Error(`Unexpected: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    const feedback = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.feedback.json'), 'utf8')) as {
      changedFiles: string[];
      stepSummaries: Array<{ stepId: string; undeclaredChangedFiles: string[] }>;
      triggerReplan: boolean;
    };
    assert.ok(feedback.changedFiles.length > 0);
    assert.ok(feedback.stepSummaries.length > 0);
    assert.equal(feedback.stepSummaries[0]?.stepId, 'step-1');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
  });
}

async function testPlannerExecuteFeedbackTriggersReplan(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        return currentPlan.includes('"step-1"')
          ? JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Single step feedback.' })
          : JSON.stringify({
              type: 'plan', plan: { version: '1', summary: 'Feedback replan test.', steps: [
                { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', details: 'Fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] }
              ] }
            });
      }
      if (request.metadata?.mode === 'mvp-json-loop') {
        const current = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
        const next = current.replace('return a - b;', 'return a + b;');
        return JSON.stringify({
          type: 'patch', patch: { version: '1', summary: 'Fix', operations: [{ type: 'replace_file', path: 'src/math.js', diff: 'Fix', oldText: current, newText: next }] }
        });
      }
      throw new Error(`Unexpected: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const feedback = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.feedback.json'), 'utf8')) as {
      changedFiles: string[];
    };
    assert.ok(feedback.changedFiles.length > 0);
  });
}

async function testPlannerExecuteAffectedSubgraphCalculator(): Promise<void> {
  const plan = {
    version: '1' as const,
    revision: 1,
    summary: 'affected subgraph fixture',
    steps: [
      { id: 'step-1', title: 'Write to math', status: 'FAILED' as const, kind: 'code' as const, attempts: 1, fileScope: ['src/math.js'], accessMode: 'write' as const, conflictDomains: ['api-contract'], dependencies: [], children: [] },
      { id: 'step-2', title: 'Write to router', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, fileScope: ['src/router.ts'], accessMode: 'write' as const, conflictDomains: ['api-contract'], dependencies: ['step-1'], children: [] },
      { id: 'step-3', title: 'Write to docs', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, fileScope: ['docs/notes.md'], accessMode: 'write' as const, dependencies: [], children: [] },
      { id: 'step-4', title: 'Run verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-2'], children: [] },
    ],
  };
  const affected = buildPlannerAffectedSubgraph(plan, 'step-1', ['src/undeclared.js']);
  assert.ok(affected.has('step-1'));
  assert.ok(affected.has('step-2'));
  assert.ok(affected.has('step-4'));
  assert.equal(affected.has('step-3'), false);
}

async function testPlannerAppendActiveLockConflict(): Promise<void> {
  const previousPlan = {
    version: '1' as const,
    revision: 1,
    summary: 'partial plan',
    isPartial: true,
    steps: [
      { id: 'step-1', title: 'Fix math', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, fileScope: ['src/math.js'], accessMode: 'write' as const, dependencies: [], children: [] },
    ],
  };
  const appendPlan = {
    version: '1' as const,
    revision: 2,
    summary: 'append conflict',
    steps: [
      { id: 'step-2', title: 'Also touch math', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, fileScope: ['src/math.js'], accessMode: 'write' as const, dependencies: [], children: [] },
    ],
  };
  const lockTable = createExecutionLockTable(1);
  const locked = acquireWriteLocks(lockTable, 'step-1', ['src/math.js'], 1);
  const errors = validateAppendActiveWaveConflict(previousPlan, appendPlan, ['step-1'], locked);
  assert.ok(errors.length > 0);
  assert.match(errors.join('; '), /active lock on src\/math\.js/);
}
