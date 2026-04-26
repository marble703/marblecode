import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { executePlannerPlan } from '../../src/planner/execute.js';
import { getPlannerExecutionStrategy } from '../../src/planner/execution-strategies.js';
import { executePlannerSubtaskWithRecovery, prepareLockTableForStep } from '../../src/planner/execute-subtask.js';
import { annotateBlockedDependents, detectPendingConflictFailure, selectExecutionWave } from '../../src/planner/execute-wave.js';
import { executePlannerVerifyStep } from '../../src/planner/execute-verify.js';
import { buildExecutionGraph } from '../../src/planner/graph.js';
import { runPlanner } from '../../src/planner/index.js';
import { acquireWriteLocks, assertStepCanWrite, createExecutionLockTable, downgradeToGuardedRead, transferWriteOwnership } from '../../src/planner/locks.js';
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
    { name: 'planner execution locks', run: testPlannerExecutionLocks },
    { name: 'planner runtime helpers', run: testPlannerRuntimeHelpers },
    { name: 'planner execution strategies', run: testPlannerExecutionStrategies },
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
    { name: 'planner execute retry recovery', run: testPlannerExecuteRetryRecovery },
    { name: 'planner execute fallback model', run: testPlannerExecuteFallbackModel },
    { name: 'planner execute local replan', run: testPlannerExecuteLocalReplan },
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
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { executionPhase: string; lastCompletedWaveStepIds: string[] };
    assert.equal(resumedExecutionState.executionPhase, 'done');
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
    assert.match(events, /subtask_replanned/);
    assert.match(state.lastReplanReason ?? '', /step-1/);
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
