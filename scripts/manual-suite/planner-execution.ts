import {
  assert,
  assertPlannerEvent,
  BranchingProvider,
  buildMathFixStep,
  buildNotesOnlyStep,
  createPlannerRegistry,
  path,
  PolicyEngine,
  readFile,
  runPlanner,
  withWorkspace,
  writeFile,
  type ManualSuiteCase,
} from './planner-shared.js';

export function createPlannerExecutionCases(): ManualSuiteCase[] {
  return [
    { name: 'planner execute chain', run: testPlannerExecuteChain },
    { name: 'planner execute concurrent wave', run: testPlannerExecuteConcurrentWave },
    { name: 'planner execute rolling window append', run: testPlannerExecuteRollingWindowAppend },
    { name: 'planner execute rolling append rejects done step mutation', run: testPlannerExecuteRollingAppendRejectsDoneStepMutation },
    { name: 'planner execute conflict policy fail', run: testPlannerExecuteConflictPolicyFail },
    { name: 'planner execute conflict domain fail', run: testPlannerExecuteConflictDomainFail },
    { name: 'planner execute conflict domain serial', run: testPlannerExecuteConflictDomainSerial },
    { name: 'planner execute degraded optional docs', run: testPlannerExecuteDegradedOptionalDocs },
    { name: 'planner execute degraded does not unblock verify', run: testPlannerExecuteDegradedDoesNotUnblockVerify },
    { name: 'planner execute feedback writes undeclared changes', run: testPlannerExecuteFeedbackWritesUndeclaredChanges },
    { name: 'planner execute feedback records changed files', run: testPlannerExecuteFeedbackRecordsChangedFiles },
  ];
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
                { id: 'step-1', title: 'Inspect math bug', status: 'PENDING', kind: 'search', details: 'Review src/math.js and tests/check-math.js.', relatedFiles: ['src/math.js', 'tests/check-math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Fix the add implementation', status: 'PENDING', kind: 'code', details: 'Change add so it returns a + b.', relatedFiles: ['src/math.js'], dependencies: ['step-1'], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run the project verifier.', dependencies: ['step-2'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Fix the add bug and run final verify.' });
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
    const executionGraph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as { waves: Array<{ stepIds: string[] }> };
    const executionLocks = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ path: string; mode: string }> };
    const verifyArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'subtask.step-3.verify.json'), 'utf8')) as { success: boolean };
    assert.equal(state.outcome, 'DONE');
    assert.match(state.message, /verifier passed|executed all subtasks/i);
    assert.equal(verifyArtifact.success, true);
    await assertPlannerEvent(result.sessionDir, 'planner_execution_started');
    await assertPlannerEvent(
      result.sessionDir,
      'subtask_completed',
      (record) => record.executor === 'coder' && record.modelAlias === 'code',
      'Expected coder completion event with code model',
    );
    await assertPlannerEvent(result.sessionDir, 'planner_execution_finished');
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

        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Fix math and notes in one execution wave, then verify.' });
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
              steps: [{ id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Run the project verifier.', dependencies: ['step-2'], children: [] }],
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
    await assertPlannerEvent(result.sessionDir, 'planner_partial_execution_completed');
    await assertPlannerEvent(result.sessionDir, 'planner_execution_window_completed');
    await assertPlannerEvent(result.sessionDir, 'plan_appended');
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
              steps: [{ id: 'step-1', title: 'Planning note only', status: 'PENDING', kind: 'search', details: 'No-op planning step.', dependencies: [], children: [] }],
            },
          });
        }
        return JSON.stringify({
          type: 'plan_append',
          plan: {
            version: '1',
            summary: 'Invalid append.',
            isPartial: false,
            steps: [{ id: 'step-1', title: 'Mutate done step', status: 'PENDING', kind: 'code', details: 'Should be rejected.', dependencies: [], children: [] }],
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
    await assertPlannerEvent(result.sessionDir, 'subtask_conflict_detected');
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
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string }> };
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
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string }> };
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'PENDING');
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
              type: 'plan', plan: { version: '1', summary: 'Feedback test.', steps: [{ id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', details: 'Fix add bug.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], accessMode: 'write', dependencies: [], children: [] }] },
            });
      }
      if (request.metadata?.mode === 'mvp-json-loop') {
        const current = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
        const next = current.replace('return a - b;', 'return a + b;');
        return JSON.stringify({ type: 'patch', patch: { version: '1', summary: 'Fix', operations: [{ type: 'replace_file', path: 'src/math.js', diff: 'Fix', oldText: current, newText: next }] } });
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
    const feedback = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.feedback.json'), 'utf8')) as { changedFiles: string[]; stepSummaries: Array<{ stepId: string }>; triggerReplan: boolean };
    assert.ok(feedback.changedFiles.length > 0);
    assert.ok(feedback.stepSummaries.length > 0);
    assert.equal(feedback.stepSummaries[0]?.stepId, 'step-1');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
  });
}

async function testPlannerExecuteFeedbackRecordsChangedFiles(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        return content.includes('"step-1"')
          ? JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Single step feedback.' })
          : JSON.stringify({
              type: 'plan', plan: { version: '1', summary: 'Feedback replan test.', steps: [{ id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', details: 'Fix add.', accessMode: 'write', dependencies: [], children: [] }] },
            });
      }
      if (request.metadata?.mode === 'mvp-json-loop') {
        const current = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
        const next = current.replace('return a - b;', 'return a + b;');
        const notes = await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8');
        return JSON.stringify({
          type: 'patch',
          patch: {
            version: '1',
            summary: 'Fix',
            operations: [
              { type: 'replace_file', path: 'src/math.js', diff: 'Fix', oldText: current, newText: next },
              { type: 'replace_file', path: 'src/notes.txt', diff: 'Undeclared notes update', oldText: notes, newText: `${notes}\nUNDECLARED_REPLAN_NOTE\n` },
            ],
          },
        });
      }
      throw new Error(`Unexpected: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js',
      explicitFiles: ['src/math.js', 'src/notes.txt'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const feedback = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.feedback.json'), 'utf8')) as { changedFiles: string[]; undeclaredChangedFiles: string[]; triggerReplan: boolean };
    assert.ok(feedback.changedFiles.length > 0);
    assert.deepEqual(feedback.changedFiles, ['src/math.js', 'src/notes.txt']);
    assert.deepEqual(feedback.undeclaredChangedFiles, []);
    assert.equal(feedback.triggerReplan, false);
  });
}
