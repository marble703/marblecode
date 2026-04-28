import {
  assert,
  BranchingProvider,
  buildExecutionGraph,
  buildInitialExecutionRuntimeContext,
  buildMathFixStep,
  buildPlannerRequestArtifact,
  classifyPlannerStep,
  createExecutionLockTable,
  createInitialExecutionState,
  createPlannerRegistry,
  createSession,
  dispatchExecutionEvent,
  executePlannerPlan,
  executePlannerSubtaskWithRecovery,
  executePlannerVerifyStep,
  FlakyProvider,
  initializePlannerState,
  mapPlannerResult,
  path,
  PolicyEngine,
  readFile,
  runPlanner,
  SequenceProvider,
  transitionExecutionPhase,
  updatePlannerStep,
  withWorkspace,
  writeFile,
  type ManualSuiteCase,
  type ModelProvider,
} from './planner-shared.js';

export function createPlannerRuntimeCases(): ManualSuiteCase[] {
  return [
    { name: 'planner runtime helpers', run: testPlannerRuntimeHelpers },
    { name: 'planner runtime recovery context helper', run: testPlannerRuntimeRecoveryContextHelper },
    { name: 'planner execution state machine transitions', run: testPlannerExecutionStateMachineTransitions },
    { name: 'planner execution event dispatch', run: testPlannerExecutionEventDispatch },
    { name: 'planner execute entry helper', run: testPlannerExecuteEntryHelper },
    { name: 'planner verify helper', run: testPlannerVerifyHelper },
    { name: 'planner subtask recovery helper', run: testPlannerSubtaskRecoveryHelper },
    { name: 'planner read-only flow', run: testPlannerReadOnlyFlow },
    { name: 'planner invalid retry and resume', run: testPlannerInvalidRetryAndResume },
    { name: 'planner resume classifier favors active wave', run: testPlannerResumeClassifierFavorsActiveWave },
    { name: 'planner resume recovers fallback path', run: testPlannerResumeRecoversFallbackPath },
    { name: 'planner execute resume from artifacts', run: testPlannerExecuteResumeFromArtifacts },
    { name: 'planner model retry', run: testPlannerModelRetry },
    { name: 'planner model retry exhaustion', run: testPlannerModelRetryExhaustion },
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
      JSON.stringify({ type: 'patch', patch: { version: '1', summary: 'should fail in planner mode', operations: [] } }),
      JSON.stringify({
        type: 'plan',
        plan: {
          version: '1',
          summary: 'Need more information before planning the route refactor.',
          steps: [{ id: 'step-1', title: 'Clarify target API surface', status: 'PENDING', kind: 'search', dependencies: [], children: [] }],
        },
      }),
      JSON.stringify({ type: 'final', outcome: 'NEEDS_INPUT', message: 'Need the target route export surface before planning the refactor.' }),
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
    const firstState = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.state.json'), 'utf8')) as { revision: number; outcome: string };
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
              { id: 'step-1', title: '查找 router 相关文件', status: 'DONE', kind: 'search', dependencies: [], children: [] },
              { id: 'step-2', title: '修改路由逻辑', status: 'PENDING', kind: 'code', dependencies: ['step-1'], children: [] },
            ],
          },
        });
      },
      JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Replanned with the new route export information.' }),
    ]);

    const resumed = await runPlanner(config, new Map([['stub', resumedProvider]]), registry, {
      prompt: '新的输入：还需要保留现有导出结构。',
      explicitFiles: [],
      pastedSnippets: [],
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.sessionDir, first.sessionDir);
    const requestArtifact = JSON.parse(await readFile(path.join(resumed.sessionDir, 'planner.request.json'), 'utf8')) as { promptHistory: string[] };
    const finalPlan = JSON.parse(await readFile(path.join(resumed.sessionDir, 'plan.json'), 'utf8')) as { revision: number; summary: string };
    const finalEvents = await readFile(path.join(resumed.sessionDir, 'plan.events.jsonl'), 'utf8');

    assert.deepEqual(requestArtifact.promptHistory, ['重构路由模块并补测试', '新的输入：还需要保留现有导出结构。']);
    assert.equal(finalPlan.revision, 2);
    assert.match(finalPlan.summary, /Replanned/);
    assert.match(finalEvents, /planner_replanned/);
  });
}

async function testPlannerResumeClassifierFavorsActiveWave(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!(request.messages[0]?.content ?? '').includes('"id": "step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Resume only the interrupted active wave.',
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Update notes', status: 'PENDING', kind: 'docs', details: 'Append a note.', relatedFiles: ['src/notes.txt'], fileScope: ['src/notes.txt'], dependencies: [], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run verifier.', dependencies: ['step-1', 'step-2'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Resume only the interrupted active wave.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        const content = request.messages[0]?.content ?? '';
        if (content.includes('Fix add implementation')) {
          return buildMathFixStep(workspaceRoot);
        }
        throw new Error('Notes step should not be rerun during active-wave resume test');
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js、更新 notes 并通过 verify',
      explicitFiles: ['src/math.js', 'src/notes.txt', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(first.status, 'failed');
    const plan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<Record<string, unknown>> };
    const updatedPlan = {
      ...plan,
      steps: plan.steps.map((step) => {
        if (step.id === 'step-1') {
          return { ...step, status: 'PENDING', executionState: 'running', lastError: 'Interrupted during executing_wave.' };
        }
        if (step.id === 'step-2') {
          return { ...step, status: 'DONE', executionState: 'done' };
        }
        return step;
      }),
    };
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(updatedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-1', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: ['step-2'], failedStepIds: [], blockedStepIds: ['step-3'], invalidResponseAttempts: 0, message: 'Interrupted during executing_wave.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'executing_wave', plannerPhase: 'PATCHING', outcome: 'RUNNING', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: ['step-2'], failedStepIds: [], blockedStepIds: ['step-3'], currentWaveStepIds: ['step-1'], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1'], interruptedStepIds: ['step-1'], resumeStrategy: 'rerun_active', strategy: 'serial', epoch: 1, currentStepId: 'step-1', message: 'Interrupted during executing_wave.', recoveryReason: 'Interrupted during executing_wave.' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/notes.txt', mode: 'guarded_read', ownerStepId: 'step-2', revision: 1 }, { path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-1', revision: 1 }] }, null, 2), 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { resumeStrategy: string; interruptedStepIds?: string[] };
    assert.equal(resumedExecutionState.resumeStrategy, 'rerun_active');
    assert.deepEqual(resumedExecutionState.interruptedStepIds ?? [], []);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
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
    const simulatedInterruptedPlan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { version: '1'; revision: number; summary: string; steps: Array<Record<string, unknown>> };
    simulatedInterruptedPlan.steps = simulatedInterruptedPlan.steps.map((step) => (step.id !== 'step-1' ? step : { ...step, status: 'PENDING', executionState: 'running', lastError: 'Interrupted during executing_wave; resuming through recovery path.' }));
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(simulatedInterruptedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-1', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], invalidResponseAttempts: 0, message: 'Interrupted during executing_wave; resuming through recovery path.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'executing_wave', plannerPhase: 'PATCHING', outcome: 'RUNNING', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], currentWaveStepIds: ['step-1'], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1'], interruptedStepIds: ['step-1'], resumeStrategy: 'rerun_active', lastEventType: 'WAVE_EXECUTED', lastEventReason: 'Interrupted during executing_wave; resuming the interrupted active wave.', strategy: 'serial', epoch: 2, currentStepId: 'step-1', message: 'Interrupted during executing_wave; resuming through recovery path.', recoveryReason: 'Interrupted during executing_wave; resuming through recovery path.' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-1', revision: 1 }] }, null, 2), 'utf8');

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
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as {
      executionPhase: string;
      lastCompletedWaveStepIds: string[];
      strategy: string;
      epoch: number;
      resumeStrategy: string;
      interruptedStepIds?: string[];
    };
    const resumedLocks = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ path: string; mode: string; ownerStepId: string }> };
    assert.equal(resumedExecutionState.executionPhase, 'done');
    assert.equal(resumedExecutionState.strategy, 'serial');
    assert.equal(resumedExecutionState.resumeStrategy, 'rerun_active');
    assert.equal(resumedExecutionState.epoch >= 1, true);
    assert.ok(resumedExecutionState.lastCompletedWaveStepIds.length >= 1);
    assert.equal(resumedLocks.entries.some((entry) => entry.path === 'src/math.js' && entry.mode === 'guarded_read' && entry.ownerStepId === 'step-1'), true);
  });
}

async function testPlannerResumeRecoversFallbackPath(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Resume through a fallback recovery path.',
              steps: [
                { id: 'step-1', title: 'Primary impossible implementation', status: 'PENDING', kind: 'code', details: 'Fail first.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'] },
                { id: 'step-1-fallback', title: 'Fallback add implementation', status: 'PENDING', kind: 'code', details: 'Use fallback to fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify after fallback.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Resume through a fallback recovery path.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        if (content.includes('Fallback add implementation')) {
          return buildMathFixStep(workspaceRoot);
        }
        throw new Error('Primary step should not be rerun during fallback-path resume');
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '通过 fallback 修复 src/math.js 并 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'completed');
    const simulatedPlan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<Record<string, unknown>> };
    const updatedPlan = {
      ...simulatedPlan,
      steps: simulatedPlan.steps.map((step) => {
        if (step.id === 'step-1') {
          return { ...step, status: 'FAILED', executionState: 'failed', lastError: 'Primary implementation failed intentionally' };
        }
        if (step.id === 'step-1-fallback') {
          return { ...step, status: 'PENDING', executionState: 'ready', lastError: 'Activated as fallback for step-1.' };
        }
        if (step.id === 'step-2') {
          return { ...step, status: 'PENDING', executionState: 'blocked' };
        }
        return step;
      }),
    };
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(updatedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'RETRYING', outcome: 'RUNNING', currentStepId: 'step-1-fallback', activeStepIds: [], readyStepIds: ['step-1-fallback'], completedStepIds: [], failedStepIds: ['step-1'], blockedStepIds: ['step-2'], invalidResponseAttempts: 0, message: 'Activated fallback step(s): step-1-fallback.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'recovering', plannerPhase: 'RETRYING', outcome: 'RUNNING', activeStepIds: [], readyStepIds: ['step-1-fallback'], completedStepIds: [], failedStepIds: ['step-1'], blockedStepIds: ['step-2'], currentWaveStepIds: [], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1-fallback'], interruptedStepIds: ['step-1-fallback'], resumeStrategy: 'resume_fallback_path', lastEventType: 'FALLBACK_ACTIVATED', lastEventReason: 'continuing fallback recovery through step-1-fallback.', strategy: 'serial', epoch: 1, currentStepId: 'step-1-fallback', message: 'Activated fallback step(s): step-1-fallback.', recoverySourceStepId: 'step-1', recoveryStepId: 'step-1-fallback', recoverySubgraphStepIds: ['step-1', 'step-1-fallback', 'step-2'], lockResumeMode: 'drop_unrelated_writes', recoveryReason: 'Activated fallback step(s): step-1-fallback.' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'guarded_read', ownerStepId: 'step-1', revision: 1 }, { path: 'src/notes.txt', mode: 'write_locked', ownerStepId: 'step-unrelated', revision: 1 }] }, null, 2), 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    const resumedPlan = JSON.parse(await readFile(path.join(resumed.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string }> };
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { executionPhase: string };
    const events = await readFile(path.join(resumed.sessionDir, 'plan.events.jsonl'), 'utf8');
    assert.equal(resumedPlan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(resumedPlan.steps.find((step) => step.id === 'step-1-fallback')?.status, 'DONE');
    assert.equal(resumedPlan.steps.find((step) => step.id === 'step-2')?.status, 'DONE');
    assert.equal(resumedExecutionState.executionPhase, 'done');
    assert.match(events, /step-1-fallback/);
    assert.match(events, /subtask_completed/);
    const resumedLocks = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ path: string; mode: string; ownerStepId: string }> };
    assert.equal(resumedLocks.entries.some((entry) => entry.ownerStepId === 'step-unrelated'), false);
  });
}

async function testPlannerModelRetry(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    config.session.modelRetryAttempts = 3;
    config.session.modelRetryDelayMs = 1;
    const provider = new FlakyProvider(2, () => JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Planner completed after retrying transient rate limits.', summary: 'retry ok' }));

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
