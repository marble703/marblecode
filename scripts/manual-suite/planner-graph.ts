import {
  acquireWriteLocks,
  annotateBlockedDependents,
  assert,
  assertStepCanWrite,
  buildExecutionGraph,
  buildPlannerAffectedSubgraph,
  collectReplanScope,
  computeUndeclaredChangedFiles,
  createExecutionLockTable,
  detectPendingConflictFailure,
  downgradeToGuardedRead,
  getPlannerExecutionStrategy,
  getReadyStepIds,
  mergePlanAppend,
  mergeReplanProposal,
  prepareLockTableForStep,
  selectExecutionWave,
  transferWriteOwnership,
  validateAppendActiveWaveConflict,
  validatePlanAppend,
  validateReplanLockCompatibility,
  validateReplanProposal,
  type ManualSuiteCase,
} from './planner-shared.js';

export function createPlannerGraphCases(): ManualSuiteCase[] {
  return [
    { name: 'planner graph and waves', run: testPlannerGraphAndWaves },
    { name: 'planner graph fallback readiness', run: testPlannerGraphFallbackReadiness },
    { name: 'planner execution locks', run: testPlannerExecutionLocks },
    { name: 'planner execution strategies', run: testPlannerExecutionStrategies },
    { name: 'planner conflict domains', run: testPlannerConflictDomains },
    { name: 'planner replan proposal validation', run: testPlannerReplanProposalValidation },
    { name: 'planner plan append validation', run: testPlannerPlanAppendValidation },
    { name: 'planner replan lock compatibility', run: testPlannerReplanLockCompatibility },
    { name: 'planner execute affected subgraph calculator', run: testPlannerExecuteAffectedSubgraphCalculator },
    { name: 'planner append active lock conflict', run: testPlannerAppendActiveLockConflict },
    { name: 'planner execute wave feedback is step scoped', run: testPlannerExecuteWaveFeedbackIsStepScoped },
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

async function testPlannerExecutionStrategies(): Promise<void> {
  const readySteps = [
    { id: 'step-1', title: 'Fix add', status: 'PENDING', kind: 'code', attempts: 0, relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
    { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', attempts: 0, relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
  ];
  const graph = buildExecutionGraph({ version: '1', revision: 1, summary: 'strategy fixture', steps: readySteps });

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
  assert.match(
    fail.checkConflicts(
      {
        version: '1',
        revision: 1,
        summary: 'conflict fixture',
        steps: conflictGraph.nodes.map((node) => ({ id: node.stepId, title: node.title, status: 'PENDING', kind: node.kind, attempts: 0, relatedFiles: node.fileScope, fileScope: node.fileScope, dependencies: node.dependencies, children: [] })),
      },
      conflictGraph,
    ) ?? '',
    /step-1/,
  );
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
    steps: [{ id: 'step-1', title: 'Rewrite done step', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, dependencies: [], children: [] }],
  };
  const invalidValidation = validatePlanAppend(previousPlan, invalidAppend);
  assert.equal(invalidValidation.ok, false);
  assert.match(invalidValidation.errors.join('; '), /redefine existing step step-1/);
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
    steps: [{ id: 'step-1', title: 'Fix math', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, fileScope: ['src/math.js'], accessMode: 'write' as const, dependencies: [], children: [] }],
  };
  const appendPlan = {
    version: '1' as const,
    revision: 2,
    summary: 'append conflict',
    steps: [{ id: 'step-2', title: 'Also touch math', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, fileScope: ['src/math.js'], accessMode: 'write' as const, dependencies: [], children: [] }],
  };
  const lockTable = createExecutionLockTable(1);
  const locked = acquireWriteLocks(lockTable, 'step-1', ['src/math.js'], 1);
  const errors = validateAppendActiveWaveConflict(previousPlan, appendPlan, ['step-1'], locked);
  assert.ok(errors.length > 0);
  assert.match(errors.join('; '), /active lock on src\/math\.js/);
}

async function testPlannerExecuteWaveFeedbackIsStepScoped(): Promise<void> {
  const mathDeclared = ['src/math.js'];
  const notesDeclared = ['src/notes.txt'];

  const mathOnly = computeUndeclaredChangedFiles(
    { id: 'step-1', title: 'Math', status: 'PENDING', kind: 'code', attempts: 0, fileScope: mathDeclared, dependencies: [], children: [] },
    mathDeclared,
    ['src/math.js'],
  );
  const notesOnly = computeUndeclaredChangedFiles(
    { id: 'step-2', title: 'Notes', status: 'PENDING', kind: 'docs', attempts: 0, fileScope: notesDeclared, dependencies: [], children: [] },
    notesDeclared,
    ['src/notes.txt'],
  );
  const notesMisattributedToMath = computeUndeclaredChangedFiles(
    { id: 'step-1', title: 'Math', status: 'PENDING', kind: 'code', attempts: 0, fileScope: mathDeclared, dependencies: [], children: [] },
    mathDeclared,
    ['src/math.js', 'src/notes.txt'],
  );
  const mathMisattributedToNotes = computeUndeclaredChangedFiles(
    { id: 'step-2', title: 'Notes', status: 'PENDING', kind: 'docs', attempts: 0, fileScope: notesDeclared, dependencies: [], children: [] },
    notesDeclared,
    ['src/notes.txt', 'src/math.js'],
  );

  assert.deepEqual(mathOnly, []);
  assert.deepEqual(notesOnly, []);
  assert.deepEqual(notesMisattributedToMath, ['src/notes.txt']);
  assert.deepEqual(mathMisattributedToNotes, ['src/math.js']);
}
