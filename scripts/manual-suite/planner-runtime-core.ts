import {
  assert,
  assertPlannerEvent,
  assertPlannerLogEntry,
  assertToolLogEntry,
  buildExecutionGraph,
  buildExecutionDispatchSnapshot,
  buildInitialExecutionRuntimeContext,
  buildInitialExecutionStateExtras,
  buildPlannerRequestArtifact,
  canAcquireRuntimeLocks,
  clearInterruptedWave,
  copyPersistedRecoverySnapshot,
  createPlannerRuntimeState,
  createRuntimeLocksFromExecutionLockTable,
  decidePlannerExecutionTurn,
  classifyPlannerStep,
  createExecutionLockTable,
  createInitialExecutionState,
  createInitialExecutionRuntimeCursor,
  createPlannerRegistry,
  createSession,
  derivePlannerAccessMode,
  derivePlannerConflictDomains,
  derivePlannerConflicts,
  derivePlannerFileScope,
  deriveReadyRuntimeTaskIds,
  dispatchExecutionEvent,
  executePlannerPlan,
  executePlannerSubtaskWithRecovery,
  executePlannerVerifyStep,
  getReadyRuntimeTasks,
  getPlannerExecutionStrategy,
  initializePlannerState,
  markPlanningWindowCompleted,
  markRecoveryFallback,
  markWaveCompleted,
  markWaveSelected,
  mapPlannerResult,
  path,
  plannerDependencySatisfied,
  plannerHasUnsatisfiedDependencies,
  readFile,
  reducePlannerRuntimeState,
  releaseRuntimeLocks,
  runPlanner,
  selectPlannerExecutionBatch,
  selectPlannerReadyQueueBatch,
  SequenceProvider,
  selectRunnableRuntimeBatch,
  transitionExecutionPhase,
  updatePlannerStep,
  withWorkspace,
  type ManualSuiteCase,
  type ModelProvider,
} from './planner-shared.js';

export function createPlannerRuntimeCoreCases(): ManualSuiteCase[] {
  return [
    { name: 'planner runtime helpers', run: testPlannerRuntimeHelpers },
    { name: 'planner execution snapshot builder', run: testPlannerExecutionSnapshotBuilder },
    { name: 'planner persisted recovery snapshot helper', run: testPlannerPersistedRecoverySnapshotHelper },
    { name: 'planner runtime recovery context helper', run: testPlannerRuntimeRecoveryContextHelper },
    { name: 'planner runtime cursor helpers', run: testPlannerRuntimeCursorHelpers },
    { name: 'planner initial execution state extras helper', run: testPlannerInitialExecutionStateExtrasHelper },
    { name: 'planner execution state machine transitions', run: testPlannerExecutionStateMachineTransitions },
    { name: 'planner execution event dispatch', run: testPlannerExecutionEventDispatch },
    { name: 'planner execute entry helper', run: testPlannerExecuteEntryHelper },
    { name: 'planner verify helper', run: testPlannerVerifyHelper },
    { name: 'planner subtask recovery helper', run: testPlannerSubtaskRecoveryHelper },
    { name: 'planner read-only flow', run: testPlannerReadOnlyFlow },
    { name: 'planner runtime dependency helpers', run: testPlannerRuntimeDependencyHelpers },
    { name: 'planner runtime metadata helpers', run: testPlannerRuntimeMetadataHelpers },
    { name: 'planner runtime scheduler helpers', run: testPlannerRuntimeSchedulerHelpers },
    { name: 'planner runtime reducer helpers', run: testPlannerRuntimeReducerHelpers },
    { name: 'planner runtime execute adapter helpers', run: testPlannerRuntimeExecuteAdapterHelpers },
  ];
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

async function testPlannerRuntimeDependencyHelpers(): Promise<void> {
  const plan = {
    version: '1' as const,
    revision: 1,
    summary: 'dependency helper fixture',
    steps: [
      { id: 'step-1', title: 'Docs', status: 'FAILED' as const, kind: 'docs' as const, attempts: 1, dependencies: [], children: [], failureTolerance: 'degrade' as const },
      { id: 'step-2', title: 'Code', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: ['step-1'], dependencyTolerances: { 'step-1': 'degrade' as const }, children: [] },
      { id: 'step-3', title: 'Verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-1'], dependencyTolerances: { 'step-1': 'degrade' as const }, children: [] },
      { id: 'step-4', title: 'Strict downstream', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: ['step-1'], children: [] },
    ],
  };

  assert.equal(plannerDependencySatisfied(plan.steps[1]!, 'step-1', plan), true);
  assert.equal(plannerDependencySatisfied(plan.steps[2]!, 'step-1', plan), false);
  assert.equal(plannerDependencySatisfied(plan.steps[3]!, 'step-1', plan), false);
  assert.equal(plannerHasUnsatisfiedDependencies(plan.steps[1]!, plan), false);
  assert.equal(plannerHasUnsatisfiedDependencies(plan.steps[2]!, plan), true);
  assert.equal(plannerHasUnsatisfiedDependencies(plan.steps[3]!, plan), true);
}

async function testPlannerRuntimeMetadataHelpers(): Promise<void> {
  const step = {
    id: 'step-1',
    title: 'Update notes',
    status: 'PENDING' as const,
    kind: 'docs' as const,
    attempts: 0,
    dependencies: [],
    children: [],
    relatedFiles: ['src/notes.txt', 'src/notes.txt'],
    conflictDomains: ['docs', 'docs'],
    conflictsWith: ['step-9', 'step-9'],
  };

  assert.equal(derivePlannerAccessMode(step), 'write');
  assert.deepEqual(derivePlannerFileScope(step), ['src/notes.txt']);
  assert.deepEqual(derivePlannerConflictDomains(step), ['docs']);
  assert.deepEqual(derivePlannerConflicts(step), ['step-9']);
  assert.equal(derivePlannerAccessMode({ ...step, kind: 'search' as const }), 'read');
  assert.equal(derivePlannerAccessMode({ ...step, kind: 'verify' as const }), 'verify');
}

async function testPlannerRuntimeSchedulerHelpers(): Promise<void> {
  const runtime = createPlannerRuntimeState({
    version: '1',
    revision: 1,
    summary: 'runtime state fixture',
    steps: [
      { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'], accessMode: 'write' },
      { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'], accessMode: 'write' },
      { id: 'step-3', title: 'API docs', status: 'PENDING', kind: 'docs', attempts: 0, dependencies: [], children: [], fileScope: ['src/api.md'], accessMode: 'write', conflictDomains: ['api-contract'] },
      { id: 'step-4', title: 'API tests', status: 'PENDING', kind: 'test', attempts: 0, dependencies: [], children: [], fileScope: ['tests/api.test.ts'], accessMode: 'write', conflictDomains: ['api-contract'] },
      { id: 'step-5', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: ['step-1'], children: [] },
      { id: 'step-6', title: 'Unknown writer', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], accessMode: 'write' },
    ],
  });

  assert.deepEqual(deriveReadyRuntimeTaskIds(runtime), ['step-1', 'step-2', 'step-3', 'step-4', 'step-6']);
  assert.deepEqual(getReadyRuntimeTasks(runtime).map((task) => task.id), ['step-1', 'step-2', 'step-3', 'step-4', 'step-6']);
  assert.deepEqual(selectRunnableRuntimeBatch(runtime, 2).map((task) => task.id), ['step-1', 'step-2']);
  assert.equal(canAcquireRuntimeLocks(runtime.locks, runtime.tasks.find((task) => task.id === 'step-1')!), true);

  const apiOnlyRuntime = {
    ...runtime,
    tasks: runtime.tasks.filter((task) => ['step-3', 'step-4'].includes(task.id)),
  };
  assert.deepEqual(selectRunnableRuntimeBatch(apiOnlyRuntime, 2).map((task) => task.id), ['step-3']);

  const unknownOnlyRuntime = {
    ...runtime,
    tasks: runtime.tasks.filter((task) => ['step-1', 'step-6'].includes(task.id)),
  };
  assert.deepEqual(selectRunnableRuntimeBatch(unknownOnlyRuntime, 2).map((task) => task.id), ['step-1']);

  const verifyRuntime = createPlannerRuntimeState({
    version: '1',
    revision: 1,
    summary: 'verify runtime fixture',
    steps: [
      { id: 'step-1', title: 'Fix math', status: 'DONE', kind: 'code', attempts: 1, dependencies: [], children: [], fileScope: ['src/math.js'], accessMode: 'write' },
      { id: 'step-2', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: ['step-1'], children: [] },
    ],
  });
  assert.deepEqual(selectRunnableRuntimeBatch(verifyRuntime, 2).map((task) => task.id), ['step-2']);
}

async function testPlannerRuntimeReducerHelpers(): Promise<void> {
  const initial = createPlannerRuntimeState({
    version: '1',
    revision: 1,
    summary: 'reducer fixture',
    steps: [
      { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'], accessMode: 'write' },
      { id: 'step-2', title: 'Verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: ['step-1'], children: [] },
    ],
  });

  const started = reducePlannerRuntimeState(initial, { type: 'TASK_STARTED', taskId: 'step-1' });
  assert.equal(started.phase, 'running');
  assert.equal(started.epoch, 1);
  assert.deepEqual(started.locks, [{ path: 'src/math.js', ownerTaskId: 'step-1' }]);

  const succeeded = reducePlannerRuntimeState(started, { type: 'TASK_SUCCEEDED', taskId: 'step-1', changedFiles: ['src/math.js'] });
  assert.deepEqual(succeeded.locks, []);
  assert.deepEqual(succeeded.tasks.find((task) => task.id === 'step-1')?.changedFiles, ['src/math.js']);
  assert.equal(succeeded.tasks.find((task) => task.id === 'step-1')?.status, 'done');

  const verifyStarted = reducePlannerRuntimeState(succeeded, { type: 'TASK_STARTED', taskId: 'step-2' });
  assert.equal(verifyStarted.phase, 'verifying');
  assert.deepEqual(verifyStarted.locks, []);

  const failed = reducePlannerRuntimeState(verifyStarted, { type: 'TASK_FAILED', taskId: 'step-2', message: 'verify failed' });
  assert.equal(failed.tasks.find((task) => task.id === 'step-2')?.status, 'failed');
  assert.equal(failed.tasks.find((task) => task.id === 'step-2')?.lastError, 'verify failed');

  const degraded = reducePlannerRuntimeState(initial, { type: 'TASK_DEGRADED', taskId: 'step-1', message: 'docs optional' });
  assert.equal(degraded.tasks.find((task) => task.id === 'step-1')?.status, 'degraded');

  const completed = reducePlannerRuntimeState(succeeded, { type: 'EXECUTION_COMPLETED', message: 'done' });
  assert.equal(completed.phase, 'done');

  const executionFailed = reducePlannerRuntimeState(succeeded, { type: 'EXECUTION_FAILED', message: 'boom' });
  assert.equal(executionFailed.phase, 'failed');

  assert.deepEqual(releaseRuntimeLocks([{ path: 'src/math.js', ownerTaskId: 'step-1' }], 'step-1'), []);
}

async function testPlannerRuntimeExecuteAdapterHelpers(): Promise<void> {
  const plan = {
    version: '1' as const,
    revision: 1,
    summary: 'adapter fixture',
    steps: [
      { id: 'step-1', title: 'Search files', status: 'PENDING' as const, kind: 'search' as const, attempts: 0, dependencies: [], children: [] },
      { id: 'step-2', title: 'Fix math', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'], accessMode: 'write' as const },
      { id: 'step-3', title: 'Update notes', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'], accessMode: 'write' as const },
      { id: 'step-4', title: 'Run verify', status: 'PENDING' as const, kind: 'verify' as const, attempts: 0, dependencies: ['step-2'], children: [] },
    ],
  };

  const readySteps = [plan.steps[0]!, plan.steps[1]!, plan.steps[2]!];
  const skipSelection = selectPlannerReadyQueueBatch({
    plan,
    readySteps,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(skipSelection.kind, 'selected');
  assert.deepEqual(skipSelection.kind === 'selected' ? skipSelection.batch.map((step) => step.id) : [], ['step-1']);

  const runnableSteps = [plan.steps[1]!, plan.steps[2]!];
  const runnableSelection = selectPlannerReadyQueueBatch({
    plan,
    readySteps: runnableSteps,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(runnableSelection.kind, 'selected');
  assert.deepEqual(runnableSelection.kind === 'selected' ? runnableSelection.batch.map((step) => step.id) : [], ['step-2', 'step-3']);

  const deterministicSelection = selectPlannerReadyQueueBatch({
    plan,
    readySteps: runnableSteps,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'deterministic',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(deterministicSelection.kind, 'selected');
  assert.deepEqual(deterministicSelection.kind === 'selected' ? deterministicSelection.batch.map((step) => step.id) : [], ['step-2']);

  const verifyPlan = {
    ...plan,
    steps: [
      { ...plan.steps[1]!, status: 'DONE' as const, attempts: 1 },
      { ...plan.steps[3]! },
    ],
  };
  const verifySelection = selectPlannerReadyQueueBatch({
    plan: verifyPlan,
    readySteps: [verifyPlan.steps[1]!],
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(verifySelection.kind, 'selected');
  assert.deepEqual(verifySelection.kind === 'selected' ? verifySelection.batch.map((step) => step.id) : [], ['step-4']);

  const lockTable = createExecutionLockTable(1);
  const locked = {
    ...lockTable,
    entries: [{ path: 'src/math.js', mode: 'write_locked' as const, ownerStepId: 'step-99', revision: 1 }],
  };
  assert.deepEqual(createRuntimeLocksFromExecutionLockTable(locked), [{ path: 'src/math.js', ownerTaskId: 'step-99' }]);
  const lockedSelection = selectPlannerReadyQueueBatch({
    plan,
    readySteps: runnableSteps,
    lockTable: locked,
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(lockedSelection.kind, 'selected');
  assert.deepEqual(lockedSelection.kind === 'selected' ? lockedSelection.batch.map((step) => step.id) : [], ['step-3']);

  const fallbackPlan = {
    ...plan,
    steps: [
      { ...plan.steps[1]!, status: 'FAILED' as const, executionState: 'failed' as const, fallbackStepIds: ['step-3'] },
      { ...plan.steps[2]! },
    ],
  };
  const fallbackSelection = selectPlannerExecutionBatch({
    plan: fallbackPlan,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => [fallbackPlan.steps[1]!],
    selectLegacyWave: (steps) => steps,
  });
  assert.equal(fallbackSelection.source, 'legacy_wave');
  assert.deepEqual(fallbackSelection.readySteps.map((step) => step.id), ['step-3']);
  assert.deepEqual(fallbackSelection.batch.map((step) => step.id), ['step-3']);

  const fallbackReadyQueueSelection = selectPlannerReadyQueueBatch({
    plan: fallbackPlan,
    readySteps: [fallbackPlan.steps[1]!],
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
  });
  assert.equal(fallbackReadyQueueSelection.kind, 'defer_legacy_fallback');

  const runtimeBlockedSelection = selectPlannerExecutionBatch({
    plan,
    lockTable: {
      ...createExecutionLockTable(1),
      entries: [
        { path: 'src/math.js', mode: 'write_locked' as const, ownerStepId: 'step-98', revision: 1 },
        { path: 'src/notes.txt', mode: 'write_locked' as const, ownerStepId: 'step-99', revision: 1 },
      ],
    },
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => runnableSteps,
    selectLegacyWave: () => {
      throw new Error('legacy wave should not be used for runtime lock blocking');
    },
  });
  assert.equal(runtimeBlockedSelection.source, 'runtime_blocked');
  assert.deepEqual(runtimeBlockedSelection.batch, []);

  const completeTurn = decidePlannerExecutionTurn({
    plan: {
      ...plan,
      steps: plan.steps.map((step) => ({ ...step, status: 'DONE' as const, attempts: step.attempts + 1 })),
    },
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => [],
    selectLegacyWave: () => [],
  });
  assert.equal(completeTurn.kind, 'complete');

  const blockedNoReadyTurn = decidePlannerExecutionTurn({
    plan,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => [],
    selectLegacyWave: () => [],
  });
  assert.equal(blockedNoReadyTurn.kind, 'blocked_no_ready');

  const runtimeBlockedTurn = decidePlannerExecutionTurn({
    plan,
    lockTable: {
      ...createExecutionLockTable(1),
      entries: [
        { path: 'src/math.js', mode: 'write_locked' as const, ownerStepId: 'step-98', revision: 1 },
        { path: 'src/notes.txt', mode: 'write_locked' as const, ownerStepId: 'step-99', revision: 1 },
      ],
    },
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => runnableSteps,
    selectLegacyWave: () => {
      throw new Error('legacy wave should not be used for runtime lock blocking');
    },
  });
  assert.equal(runtimeBlockedTurn.kind, 'blocked_runtime_locks');

  const executeBatchTurn = decidePlannerExecutionTurn({
    plan,
    lockTable: createExecutionLockTable(1),
    strategyMode: 'serial',
    maxConcurrentSubtasks: 2,
    classifyPlannerStep,
    getReadySteps: () => runnableSteps,
    selectLegacyWave: () => [],
  });
  assert.equal(executeBatchTurn.kind, 'execute_batch');
  assert.deepEqual(executeBatchTurn.kind === 'execute_batch' ? executeBatchTurn.batch.map((step) => step.id) : [], ['step-2', 'step-3']);
}

async function testPlannerRuntimeRecoveryContextHelper(): Promise<void> {
  const lockTable = {
    version: '1' as const,
    revision: 2,
    entries: [
      { path: 'src/math.js', mode: 'guarded_read' as const, ownerStepId: 'step-1', revision: 2 },
      { path: 'src/notes.txt', mode: 'write_locked' as const, ownerStepId: 'step-2', revision: 2 },
    ],
  };
  const context = buildInitialExecutionRuntimeContext(lockTable, {
    version: '1',
    revision: 2,
    executionPhase: 'recovering',
    plannerPhase: 'RETRYING',
    outcome: 'RUNNING',
    activeStepIds: [],
    readyStepIds: ['step-2'],
    completedStepIds: ['step-1'],
    failedStepIds: [],
    blockedStepIds: ['step-3'],
    degradedStepIds: [],
    currentWaveStepIds: ['step-2'],
    lastCompletedWaveStepIds: ['step-1'],
    selectedWaveStepIds: ['step-2'],
    strategy: 'serial',
    epoch: 4,
    currentStepId: 'step-2',
    message: 'recovering',
    interruptedStepIds: ['step-2'],
    recoverySourceStepId: 'step-1',
    recoverySubgraphStepIds: ['step-1', 'step-2', 'step-3'],
    lockResumeMode: 'drop_unrelated_writes',
    recoveryStepId: 'step-2',
    recoveryReason: 'recovering through step-2',
  });

  assert.deepEqual(context.currentWaveStepIds, ['step-2']);
  assert.deepEqual(context.lastCompletedWaveStepIds, ['step-1']);
  assert.deepEqual(context.selectedWaveStepIds, ['step-2']);
  assert.deepEqual(context.interruptedStepIds, ['step-2']);
  assert.equal(context.executionEpoch, 4);
  assert.deepEqual(context.activeLockOwnerStepIds, ['step-2']);
  assert.equal(context.recoverySourceStepId, 'step-1');
  assert.deepEqual(context.recoverySubgraphStepIds, ['step-1', 'step-2', 'step-3']);
  assert.equal(context.lockResumeMode, 'drop_unrelated_writes');
  assert.equal(context.planningWindowState, '');
  assert.deepEqual(context.reusedLockOwnerStepIds, []);
  assert.deepEqual(context.preservedLockOwnerStepIds, []);
  assert.deepEqual(context.downgradedLockOwnerStepIds, []);
  assert.deepEqual(context.droppedLockOwnerStepIds, []);
  assert.equal(context.recoveryStepId, 'step-2');
  assert.equal(context.recoveryReason, 'recovering through step-2');
  assert.equal(context.lastEventReason, '');
  assert.equal(context.resumeStrategy, undefined);
  assert.equal(context.lockTable.entries.some((entry) => entry.ownerStepId === 'step-2' && entry.mode === 'write_locked'), true);
}

async function testPlannerRuntimeCursorHelpers(): Promise<void> {
  const initialRuntime = buildInitialExecutionRuntimeContext({
    version: '1',
    revision: 2,
    entries: [{ path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-2', revision: 2 }],
  }, {
    version: '1',
    revision: 2,
    executionPhase: 'executing_wave',
    plannerPhase: 'PATCHING',
    outcome: 'RUNNING',
    activeStepIds: ['step-2'],
    readyStepIds: [],
    completedStepIds: ['step-1'],
    failedStepIds: [],
    blockedStepIds: ['step-3'],
    degradedStepIds: [],
    currentWaveStepIds: ['step-2'],
    lastCompletedWaveStepIds: ['step-1'],
    selectedWaveStepIds: ['step-2'],
    interruptedStepIds: ['step-2'],
    strategy: 'serial',
    epoch: 4,
    currentStepId: 'step-2',
    message: 'recovering',
    planningWindowState: 'executing',
  });

  const initialCursor = createInitialExecutionRuntimeCursor(initialRuntime);
  assert.deepEqual(initialCursor.currentWaveStepIds, ['step-2']);
  assert.deepEqual(initialCursor.lastCompletedWaveStepIds, ['step-1']);
  assert.equal(initialCursor.epoch, 4);
  assert.equal(initialCursor.planningWindowState, 'executing');

  const selectedCursor = markWaveSelected(initialCursor, ['step-4', 'step-5']);
  assert.deepEqual(selectedCursor.currentWaveStepIds, ['step-4', 'step-5']);
  assert.deepEqual(selectedCursor.selectedWaveStepIds, ['step-4', 'step-5']);
  assert.deepEqual(selectedCursor.interruptedStepIds, ['step-4', 'step-5']);
  assert.equal(selectedCursor.epoch, 5);

  const fallbackCursor = markRecoveryFallback(selectedCursor, ['step-4-fallback']);
  assert.deepEqual(fallbackCursor.currentWaveStepIds, []);
  assert.deepEqual(fallbackCursor.interruptedStepIds, ['step-4-fallback']);

  const clearedCursor = clearInterruptedWave(fallbackCursor);
  assert.deepEqual(clearedCursor.currentWaveStepIds, []);
  assert.deepEqual(clearedCursor.interruptedStepIds, []);

  const completedCursor = markWaveCompleted(selectedCursor);
  assert.deepEqual(completedCursor.lastCompletedWaveStepIds, ['step-4', 'step-5']);
  assert.deepEqual(completedCursor.currentWaveStepIds, []);
  assert.deepEqual(completedCursor.interruptedStepIds, []);

  const completedWindowCursor = markPlanningWindowCompleted(completedCursor);
  assert.equal(completedWindowCursor.planningWindowState, 'completed_waiting_append');
}

async function testPlannerInitialExecutionStateExtrasHelper(): Promise<void> {
  const runtime = buildInitialExecutionRuntimeContext({
    version: '1',
    revision: 3,
    entries: [{ path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-2', revision: 3 }],
  }, {
    version: '1',
    revision: 3,
    executionPhase: 'recovering',
    plannerPhase: 'RETRYING',
    outcome: 'RUNNING',
    activeStepIds: ['step-2'],
    readyStepIds: [],
    completedStepIds: ['step-1'],
    failedStepIds: [],
    blockedStepIds: ['step-3'],
    degradedStepIds: [],
    currentWaveStepIds: ['step-2'],
    lastCompletedWaveStepIds: ['step-1'],
    selectedWaveStepIds: ['step-2'],
    interruptedStepIds: ['step-2'],
    strategy: 'serial',
    epoch: 3,
    currentStepId: 'step-2',
    message: 'resuming',
    resumeStrategy: 'resume_recovering',
    lastEventReason: 'continue recovery',
    activeLockOwnerStepIds: ['step-2'],
    preservedLockOwnerStepIds: ['step-1'],
    reusedLockOwnerStepIds: ['step-1'],
    downgradedLockOwnerStepIds: ['step-2'],
    droppedLockOwnerStepIds: ['step-unrelated'],
    recoverySourceStepId: 'step-1',
    recoverySubgraphStepIds: ['step-1', 'step-2', 'step-3'],
    lockResumeMode: 'drop_unrelated_writes',
    planningWindowState: 'executing',
    recoveryStepId: 'step-2',
    recoveryReason: 'continue recovery',
  });
  const cursor = createInitialExecutionRuntimeCursor(runtime);
  const extras = buildInitialExecutionStateExtras(cursor, runtime);

  assert.deepEqual(extras.currentWaveStepIds, ['step-2']);
  assert.deepEqual(extras.lastCompletedWaveStepIds, ['step-1']);
  assert.deepEqual(extras.selectedWaveStepIds, ['step-2']);
  assert.deepEqual(extras.interruptedStepIds, ['step-2']);
  assert.equal(extras.resumeStrategy, 'resume_recovering');
  assert.deepEqual(extras.activeLockOwnerStepIds, ['step-2']);
  assert.deepEqual(extras.reusedLockOwnerStepIds, ['step-1']);
  assert.equal(extras.lockResumeMode, 'drop_unrelated_writes');
  assert.equal(extras.planningWindowState, 'executing');
  assert.equal(extras.recoveryStepId, 'step-2');
  assert.equal(extras.recoveryReason, 'continue recovery');
}

async function testPlannerPersistedRecoverySnapshotHelper(): Promise<void> {
  const snapshot = copyPersistedRecoverySnapshot({
    version: '1',
    revision: 2,
    executionPhase: 'recovering',
    plannerPhase: 'RETRYING',
    outcome: 'RUNNING',
    activeStepIds: ['step-2'],
    readyStepIds: [],
    completedStepIds: ['step-1'],
    failedStepIds: [],
    blockedStepIds: ['step-3'],
    degradedStepIds: [],
    currentWaveStepIds: ['step-2'],
    lastCompletedWaveStepIds: ['step-1'],
    strategy: 'serial',
    epoch: 2,
    currentStepId: 'step-2',
    message: 'recovering',
    resumeStrategy: 'resume_fallback_path',
    preservedLockOwnerStepIds: ['step-1'],
    reusedLockOwnerStepIds: ['step-1'],
    downgradedLockOwnerStepIds: ['step-2'],
    droppedLockOwnerStepIds: ['step-unrelated'],
    recoverySourceStepId: 'step-1',
    recoverySubgraphStepIds: ['step-1', 'step-2', 'step-3'],
    lockResumeMode: 'drop_unrelated_writes',
    recoveryStepId: 'step-2',
    recoveryReason: 'continue recovery',
  });

  assert.equal(snapshot.resumeStrategy, 'resume_fallback_path');
  assert.deepEqual(snapshot.preservedLockOwnerStepIds, ['step-1']);
  assert.deepEqual(snapshot.reusedLockOwnerStepIds, ['step-1']);
  assert.deepEqual(snapshot.droppedLockOwnerStepIds, ['step-unrelated']);
  assert.equal(snapshot.recoverySourceStepId, 'step-1');
  assert.equal(snapshot.lockResumeMode, 'drop_unrelated_writes');
  assert.equal(snapshot.recoveryStepId, 'step-2');
  assert.equal(snapshot.recoveryReason, 'continue recovery');
}

async function testPlannerExecutionSnapshotBuilder(): Promise<void> {
  const lockTable = {
    version: '1' as const,
    revision: 3,
    entries: [
      { path: 'src/math.js', mode: 'write_locked' as const, ownerStepId: 'step-2', revision: 3 },
    ],
  };
  const snapshot = buildExecutionDispatchSnapshot({
    state: {
      version: '1',
      revision: 3,
      phase: 'PATCHING',
      outcome: 'RUNNING',
      currentStepId: 'step-2',
      activeStepIds: ['step-2'],
      readyStepIds: [],
      completedStepIds: ['step-1'],
      failedStepIds: [],
      blockedStepIds: ['step-3'],
      invalidResponseAttempts: 0,
      message: 'resuming',
      consistencyErrors: [],
    },
    strategy: 'serial',
    lockTable,
    executionState: {
      version: '1',
      revision: 3,
      executionPhase: 'recovering',
      plannerPhase: 'RETRYING',
      outcome: 'RUNNING',
      activeStepIds: ['step-2'],
      readyStepIds: [],
      completedStepIds: ['step-1'],
      failedStepIds: [],
      blockedStepIds: ['step-3'],
      degradedStepIds: [],
      currentWaveStepIds: ['step-2'],
      lastCompletedWaveStepIds: ['step-1'],
      strategy: 'serial',
      epoch: 3,
      currentStepId: 'step-2',
      message: 'resuming',
      resumeStrategy: 'resume_recovering',
      preservedLockOwnerStepIds: ['step-1'],
      reusedLockOwnerStepIds: ['step-1'],
      downgradedLockOwnerStepIds: ['step-2'],
      recoverySourceStepId: 'step-1',
      recoverySubgraphStepIds: ['step-1', 'step-2', 'step-3'],
      lockResumeMode: 'drop_unrelated_writes',
      planningWindowState: 'executing',
      recoveryStepId: 'step-2',
      recoveryReason: 'continue recovery',
    },
    currentWaveStepIds: ['step-2'],
    lastCompletedWaveStepIds: ['step-1'],
    selectedWaveStepIds: ['step-2'],
    interruptedStepIds: ['step-2'],
    epoch: 4,
    planningWindowState: 'executing',
    recoveryStepId: 'step-2',
    recoveryReason: 'continue recovery',
  });

  assert.deepEqual(snapshot.currentWaveStepIds, ['step-2']);
  assert.deepEqual(snapshot.lastCompletedWaveStepIds, ['step-1']);
  assert.deepEqual(snapshot.selectedWaveStepIds, ['step-2']);
  assert.deepEqual(snapshot.interruptedStepIds, ['step-2']);
  assert.equal(snapshot.resumeStrategy, 'resume_recovering');
  assert.deepEqual(snapshot.activeLockOwnerStepIds, ['step-2']);
  assert.deepEqual(snapshot.reusedLockOwnerStepIds, ['step-1']);
  assert.equal(snapshot.planningWindowState, 'executing');
  assert.equal(snapshot.recoveryStepId, 'step-2');
  assert.equal(snapshot.recoveryReason, 'continue recovery');
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
      steps: [{ id: 'step-1', title: 'Update notes', status: 'PENDING' as const, kind: 'docs' as const, attempts: 0, dependencies: [], children: [], fileScope: ['src/notes.txt'] }],
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
      selectedWaveStepIds: ['step-1'],
      interruptedStepIds: ['step-1'],
      resumeStrategy: 'rerun_active',
      lastEventReason: 'lock acquired for step-1',
      activeLockOwnerStepIds: ['step-1'],
    });
    assert.equal(executionState.executionPhase, 'locking');

    const persisted = JSON.parse(await readFile(path.join(session.dir, 'execution.state.json'), 'utf8')) as {
      executionPhase: string;
      currentWaveStepIds: string[];
      selectedWaveStepIds: string[];
      interruptedStepIds: string[];
      resumeStrategy: string;
      activeLockOwnerStepIds: string[];
      lastEventType: string;
      epoch: number;
    };
    assert.equal(persisted.executionPhase, 'locking');
    assert.deepEqual(persisted.currentWaveStepIds, ['step-1']);
    assert.deepEqual(persisted.selectedWaveStepIds, ['step-1']);
    assert.deepEqual(persisted.interruptedStepIds, ['step-1']);
    assert.deepEqual(persisted.activeLockOwnerStepIds, ['step-1']);
    assert.equal(persisted.resumeStrategy, 'rerun_active');
    assert.equal(persisted.lastEventType, 'LOCKS_ACQUIRED');
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
        steps: [{ id: 'step-1', title: 'Search files only', status: 'PENDING', kind: 'search', attempts: 0, dependencies: [], children: [] }],
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
        updatePlannerStep: (plan, stepId, updates) => ({ ...plan, steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)) }),
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
        steps: [{ id: 'verify-step', title: 'Run verify', status: 'PENDING', kind: 'verify', attempts: 0, dependencies: [], children: [] }],
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
        updatePlannerStep: (plan, stepId, updates) => ({ ...plan, steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)) }),
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
          steps: [{ id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', attempts: 0, dependencies: [], children: [], fileScope: ['src/math.js'] }],
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
        (plan, stepId, updates) => ({ ...plan, steps: plan.steps.map((step) => (step.id === stepId ? { ...step, ...updates } : step)) }),
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
              { id: 'step-1', title: '查找 router 相关文件', status: 'PENDING', kind: 'search', details: '定位 router/register/export/test 相关实现和入口。', dependencies: [], children: [] },
              { id: 'step-2', title: '修改路由逻辑', status: 'PENDING', kind: 'code', dependencies: ['step-1'], children: [] },
              { id: 'step-3', title: '更新测试', status: 'PENDING', kind: 'test', dependencies: ['step-2'], children: [] },
              { id: 'step-4', title: '执行 verify', status: 'PENDING', kind: 'verify', dependencies: ['step-3'], children: [] },
            ],
          },
        }),
        JSON.stringify({ type: 'plan_update', stepId: 'step-1', status: 'SEARCHING', message: 'Searching router and register files.', relatedFiles: ['src/router.js', 'src/register-routes.js'] }),
        JSON.stringify({ type: 'tool_call', tool: 'search_text', input: { pattern: 'registerRoute|router', pathPattern: 'src/**/*.js' } }),
        JSON.stringify({ type: 'plan_update', stepId: 'step-1', status: 'DONE', message: 'Identified the router implementation and registration entry points.', relatedFiles: ['src/router.js', 'src/register-routes.js', 'src/server.js'] }),
        JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan captured and ready for execution.', summary: '1. 查找 router 相关文件 2. 修改路由逻辑 3. 更新测试 4. 执行 verify' }),
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
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { revision: number; summary: string; steps: Array<{ id: string; status: string; relatedFiles?: string[] }> };
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { outcome: string; phase: string; message: string };
    const contextPacket = JSON.parse(await readFile(path.join(result.sessionDir, 'planner.context.packet.json'), 'utf8')) as { constraints: { readOnly: boolean; allowedTools: string[] }; queryTerms: string[] };
    assert.equal(plan.revision, 1);
    assert.match(plan.summary, /1\. 查找 router/);
    assert.equal(plan.steps[0]?.status, 'DONE');
    assert.deepEqual(plan.steps[0]?.relatedFiles, ['src/router.js', 'src/register-routes.js', 'src/server.js']);
    assert.equal(state.outcome, 'DONE');
    assert.equal(contextPacket.constraints.readOnly, true);
    assert.deepEqual(contextPacket.constraints.allowedTools, ['read_file', 'list_files', 'search_text', 'git_status', 'git_log', 'git_show', 'git_diff', 'git_diff_base']);
    assert.ok(contextPacket.queryTerms.includes('router'));
    await assertPlannerEvent(result.sessionDir, 'planner_started');
    await assertPlannerEvent(result.sessionDir, 'plan_step_updated', (record) => record.stepId === 'step-1');
    await assertPlannerLogEntry(result.sessionDir, 'plan_snapshot');
    await assertPlannerLogEntry(result.sessionDir, 'planner_terminal');
    await assertToolLogEntry(result.sessionDir, 'search_text', () => true, 'Expected search_text tool log entry during read-only planner flow');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /BUG_MARKER/);
  });
}
