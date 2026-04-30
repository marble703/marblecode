import {
  assert,
  BranchingProvider,
  buildExecutionGraph,
  buildMathFixStep,
  classifyPlannerStep,
  createPlannerRegistry,
  createSession,
  executePlannerPlan,
  FlakyProvider,
  path,
  PolicyEngine,
  readFile,
  runPlanner,
  SequenceProvider,
  updatePlannerStep,
  withWorkspace,
  writeFile,
  type ManualSuiteCase,
} from './planner-shared.js';

export function createPlannerRuntimeResumeCases(): ManualSuiteCase[] {
  return [
    { name: 'planner invalid retry and resume', run: testPlannerInvalidRetryAndResume },
    { name: 'planner resume classifier favors active wave', run: testPlannerResumeClassifierFavorsActiveWave },
    { name: 'planner resume recovers fallback path', run: testPlannerResumeRecoversFallbackPath },
    { name: 'planner execute resume from artifacts', run: testPlannerExecuteResumeFromArtifacts },
    { name: 'planner resume reuses eligible lock owners', run: testPlannerResumeReusesEligibleLockOwners },
    { name: 'planner resume drops ineligible active writers', run: testPlannerResumeDropsIneligibleActiveWriters },
    { name: 'planner resume interrupted planning window reruns active wave', run: testPlannerResumeInterruptedPlanningWindowRerunsActiveWave },
    { name: 'planner resume interrupted planning window recovers fallback path', run: testPlannerResumeInterruptedPlanningWindowRecoversFallbackPath },
    { name: 'planner resume completed planning window does not rerun', run: testPlannerResumeCompletedPlanningWindowDoesNotRerun },
    { name: 'planner model retry', run: testPlannerModelRetry },
    { name: 'planner model retry exhaustion', run: testPlannerModelRetryExhaustion },
  ];
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
                { id: 'step-1', title: 'Primary impossible implementation', status: 'PENDING', kind: 'code', details: 'Fail first.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'], ownershipTransfers: ['step-1-fallback'] },
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
    assert.equal(resumedLocks.entries.some((entry) => entry.path === 'src/math.js' && entry.mode === 'guarded_read'), true);
    assert.equal(resumedLocks.entries.some((entry) => entry.ownerStepId === 'step-unrelated'), false);
  });
}

async function testPlannerResumeReusesEligibleLockOwners(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Resume with reusable guarded ownership.',
              steps: [
                { id: 'step-1', title: 'Initial math edit', status: 'PENDING', kind: 'code', details: 'Own math first.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Continue math edit', status: 'PENDING', kind: 'code', details: 'Continue after step-1.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: ['step-1'], children: [] },
                { id: 'step-3', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify.', dependencies: ['step-2'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Resume with reusable guarded ownership.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        if (content.includes('Continue math edit')) {
          return buildMathFixStep(workspaceRoot);
        }
        throw new Error('Only step-2 should execute during owner reuse resume');
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '生成可恢复 ownership 的计划',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'completed');
    const plan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<Record<string, unknown>> };
    const interruptedPlan = {
      ...plan,
      steps: plan.steps.map((step) => {
        if (step.id === 'step-1') {
          return { ...step, status: 'DONE', executionState: 'done' };
        }
        if (step.id === 'step-2') {
          return { ...step, status: 'PENDING', executionState: 'running', lastError: 'Interrupted during step-2.' };
        }
        return step;
      }),
    };
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(interruptedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-2', activeStepIds: ['step-2'], readyStepIds: [], completedStepIds: ['step-1'], failedStepIds: [], blockedStepIds: ['step-3'], invalidResponseAttempts: 0, message: 'Interrupted during step-2.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.graph.json'), JSON.stringify(buildExecutionGraph(interruptedPlan), null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'executing_wave', plannerPhase: 'PATCHING', outcome: 'RUNNING', activeStepIds: ['step-2'], readyStepIds: [], completedStepIds: ['step-1'], failedStepIds: [], blockedStepIds: ['step-3'], currentWaveStepIds: ['step-2'], lastCompletedWaveStepIds: ['step-1'], selectedWaveStepIds: ['step-2'], interruptedStepIds: ['step-2'], resumeStrategy: 'rerun_active', lastEventType: 'WAVE_EXECUTED', lastEventReason: 'Interrupted during step-2.', strategy: 'serial', epoch: 2, currentStepId: 'step-2', message: 'Interrupted during step-2.', planningWindowState: 'executing' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'guarded_read', ownerStepId: 'step-1', revision: 1 }] }, null, 2), 'utf8');
    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { reusedLockOwnerStepIds?: string[]; preservedLockOwnerStepIds?: string[]; resumeStrategy?: string };
    assert.equal(resumedExecutionState.resumeStrategy, 'rerun_active');
    assert.deepEqual(resumedExecutionState.reusedLockOwnerStepIds ?? [], ['step-1']);
    assert.deepEqual(resumedExecutionState.preservedLockOwnerStepIds ?? [], ['step-1']);
  });
}

async function testPlannerResumeDropsIneligibleActiveWriters(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Resume drops unrelated writer.',
              steps: [
                { id: 'step-1', title: 'Fix math', status: 'PENDING', kind: 'code', details: 'Fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Resume drops unrelated writer.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '生成会丢弃无关 writer 的恢复计划',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'completed');
    const plan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<Record<string, unknown>> };
    const interruptedPlan = {
      ...plan,
      steps: plan.steps.map((step) => (step.id === 'step-1' ? { ...step, status: 'PENDING', executionState: 'running', lastError: 'Interrupted.' } : step)),
    };
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(interruptedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-1', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], invalidResponseAttempts: 0, message: 'Interrupted.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.graph.json'), JSON.stringify(buildExecutionGraph(interruptedPlan), null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'executing_wave', plannerPhase: 'PATCHING', outcome: 'RUNNING', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], currentWaveStepIds: ['step-1'], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1'], interruptedStepIds: ['step-1'], resumeStrategy: 'rerun_active', lastEventType: 'WAVE_EXECUTED', strategy: 'serial', epoch: 1, currentStepId: 'step-1', message: 'Interrupted.', planningWindowState: 'executing' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-1', revision: 1 }, { path: 'src/notes.txt', mode: 'write_locked', ownerStepId: 'step-unrelated', revision: 1 }] }, null, 2), 'utf8');
    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { droppedLockOwnerStepIds?: string[]; downgradedLockOwnerStepIds?: string[] };
    const resumedLocks = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ ownerStepId: string; mode: string }> };
    assert.deepEqual(resumedExecutionState.droppedLockOwnerStepIds ?? [], ['step-unrelated']);
    assert.equal((resumedExecutionState.downgradedLockOwnerStepIds ?? []).includes('step-1'), true);
    assert.equal(resumedLocks.entries.some((entry) => entry.ownerStepId === 'step-unrelated'), false);
  });
}

async function testPlannerResumeCompletedPlanningWindowDoesNotRerun(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.planningWindowWaves = 1;
    let subtaskExecutions = 0;
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (content.includes('"id": "step-2"') || content.includes('"id":"step-2"')) {
          return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Partial window resume completed.' });
        }
        return JSON.stringify({
          type: 'plan_append',
          plan: {
            version: '1',
            summary: 'Append final planning note.',
            isPartial: false,
            steps: [{ id: 'step-2', title: 'Record final note', status: 'PENDING', kind: 'search', details: 'No-op final planning note.', dependencies: ['step-1'], children: [] }],
          },
        });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        subtaskExecutions += 1;
        throw new Error('Completed planning window should not rerun already completed subtasks on resume');
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const session = await createSession(config);
    const partialPlan = {
      version: '1' as const,
      revision: 1,
      summary: 'Partial window resume boundary.',
      isPartial: true,
      planningHorizon: { waveCount: 1 },
      steps: [{ id: 'step-1', title: 'Fix add implementation', status: 'DONE' as const, kind: 'code' as const, details: 'Fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], executionState: 'done' as const, attempts: 1 }],
    };
    const partialState = {
      version: '1' as const,
      revision: 1,
      phase: 'REPLANNING' as const,
      outcome: 'RUNNING' as const,
      currentStepId: null,
      activeStepIds: [],
      readyStepIds: [],
      completedStepIds: ['step-1'],
      failedStepIds: [],
      blockedStepIds: [],
      invalidResponseAttempts: 0,
      message: 'Executed partial planner window at revision 1; requesting next planning window.',
      consistencyErrors: [],
    };
    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a + b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');
    await writeFile(path.join(session.dir, 'planner.request.json'), JSON.stringify({ promptHistory: ['先执行 partial window，然后等待 append'], explicitFiles: ['src/math.js'], pastedSnippets: [], resumedFrom: null }, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'planner.context.json'), JSON.stringify({ queryTerms: [], items: [] }, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'planner.context.packet.json'), JSON.stringify({ version: '1', objective: '先执行 partial window，然后等待 append', request: '先执行 partial window，然后等待 append', explicitFiles: ['src/math.js'], pastedSnippets: [], queryTerms: [], contextItems: [], constraints: { readOnly: true, allowedTools: [], maxSteps: 8 }, planRevision: 1 }, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'plan.json'), JSON.stringify(partialPlan, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'plan.state.json'), JSON.stringify(partialState, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'plan.events.jsonl'), `${JSON.stringify({ type: 'planner_execution_window_completed', revision: 1, executedWaveCount: 1, planningWindowWaves: 1 })}\n`, 'utf8');
    await writeFile(path.join(session.dir, 'execution.graph.json'), JSON.stringify(buildExecutionGraph(partialPlan), null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'guarded_read', ownerStepId: 'step-1', revision: 1 }] }, null, 2), 'utf8');
    await writeFile(path.join(session.dir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'done', plannerPhase: 'REPLANNING', outcome: 'RUNNING', activeStepIds: [], readyStepIds: [], completedStepIds: ['step-1'], failedStepIds: [], blockedStepIds: [], degradedStepIds: [], currentWaveStepIds: [], lastCompletedWaveStepIds: ['step-1'], strategy: 'serial', epoch: 1, currentStepId: null, message: 'Executed partial planner window at revision 1; requesting next planning window.', planningWindowState: 'completed_waiting_append' }, null, 2), 'utf8');

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: session.dir,
    });

    assert.equal(resumed.status, 'completed');
    assert.equal(subtaskExecutions, 0);
    const finalPlan = JSON.parse(await readFile(path.join(resumed.sessionDir, 'plan.json'), 'utf8')) as { isPartial?: boolean; steps: Array<{ id: string; status: string }> };
    assert.equal(finalPlan.isPartial, false);
    assert.equal(finalPlan.steps.find((step) => step.id === 'step-1')?.status, 'DONE');
    assert.equal(finalPlan.steps.find((step) => step.id === 'step-2')?.status, 'DONE');
  });
}

async function testPlannerResumeInterruptedPlanningWindowRerunsActiveWave(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.planningWindowWaves = 1;
    let subtaskExecutions = 0;
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Interrupted partial planning window.',
              isPartial: true,
              planningHorizon: { waveCount: 1 },
              steps: [
                { id: 'step-1', title: 'Fix add implementation', status: 'PENDING', kind: 'code', details: 'Fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Interrupted partial planning window.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        subtaskExecutions += 1;
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const first = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '生成一个会在 partial window 中断的计划',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'completed');
    const plan = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.json'), 'utf8')) as { isPartial?: boolean; planningHorizon?: { waveCount?: number }; steps: Array<Record<string, unknown>> };
    const interruptedPlan = {
      ...plan,
      steps: plan.steps.map((step) => {
        if (step.id === 'step-1') {
          return { ...step, status: 'PENDING', executionState: 'running', lastError: 'Interrupted during partial planning window.' };
        }
        return step;
      }),
    };
    await writeFile(path.join(first.sessionDir, 'plan.json'), JSON.stringify(interruptedPlan, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'plan.state.json'), JSON.stringify({ version: '1', revision: 1, phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-1', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], invalidResponseAttempts: 0, message: 'Interrupted during partial planning window.', consistencyErrors: [] }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.graph.json'), JSON.stringify(buildExecutionGraph(interruptedPlan), null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.state.json'), JSON.stringify({ version: '1', revision: 1, executionPhase: 'executing_wave', plannerPhase: 'PATCHING', outcome: 'RUNNING', activeStepIds: ['step-1'], readyStepIds: [], completedStepIds: [], failedStepIds: [], blockedStepIds: ['step-2'], degradedStepIds: [], currentWaveStepIds: ['step-1'], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1'], interruptedStepIds: ['step-1'], resumeStrategy: 'rerun_active', strategy: 'serial', epoch: 1, currentStepId: 'step-1', message: 'Interrupted during partial planning window.', planningWindowState: 'executing' }, null, 2), 'utf8');
    await writeFile(path.join(first.sessionDir, 'execution.locks.json'), JSON.stringify({ version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'write_locked', ownerStepId: 'step-1', revision: 1 }] }, null, 2), 'utf8');
    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');

    const resumed = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '',
      explicitFiles: [],
      pastedSnippets: [],
      executeSubtasks: true,
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.equal(subtaskExecutions, 1);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const resumedExecutionState = JSON.parse(await readFile(path.join(resumed.sessionDir, 'execution.state.json'), 'utf8')) as { planningWindowState?: string; resumeStrategy?: string; lastCompletedWaveStepIds?: string[] };
    assert.equal(resumedExecutionState.resumeStrategy, 'rerun_active');
    assert.equal(resumedExecutionState.planningWindowState, 'completed_waiting_append');
    assert.deepEqual(resumedExecutionState.lastCompletedWaveStepIds ?? [], ['step-1']);
  });
}

async function testPlannerResumeInterruptedPlanningWindowRecoversFallbackPath(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.routing.planningWindowWaves = 1;
    let fallbackExecutions = 0;
    const provider = new BranchingProvider(async (request) => {
      const content = request.messages[0]?.content ?? '';
      if (request.metadata?.mode === 'planner-json-loop') {
        if (!content.includes('"id": "step-1"') && !content.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Interrupted partial planning window through fallback recovery.',
              isPartial: true,
              planningHorizon: { waveCount: 1 },
              steps: [
                { id: 'step-1', title: 'Primary impossible implementation', status: 'PENDING', kind: 'code', details: 'Fail first.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'] },
                { id: 'step-1-fallback', title: 'Fallback add implementation', status: 'PENDING', kind: 'code', details: 'Use fallback to fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [] },
                { id: 'step-2', title: 'Run final verify', status: 'PENDING', kind: 'verify', details: 'Verify after fallback.', dependencies: ['step-1'], children: [] },
              ],
            },
          });
        }
        return JSON.stringify({ type: 'final', outcome: 'DONE', message: 'Plan complete', summary: 'Interrupted partial planning window through fallback recovery.' });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        if (content.includes('Fallback add implementation')) {
          fallbackExecutions += 1;
          return buildMathFixStep(workspaceRoot);
        }
        throw new Error('Primary step should not be rerun during interrupted fallback planning window resume');
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const session = await createSession(config);
    const interruptedPlan = {
      version: '1' as const,
      revision: 1,
      summary: 'Interrupted partial planning window through fallback recovery.',
      isPartial: true,
      planningHorizon: { waveCount: 1 },
      steps: [
        { id: 'step-1', title: 'Primary impossible implementation', status: 'FAILED' as const, kind: 'code' as const, attempts: 1, details: 'Fail first.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], fallbackStepIds: ['step-1-fallback'], ownershipTransfers: ['step-1-fallback'], executionState: 'failed' as const, lastError: 'Primary implementation failed intentionally' },
        { id: 'step-1-fallback', title: 'Fallback add implementation', status: 'PENDING' as const, kind: 'code' as const, attempts: 0, details: 'Use fallback to fix add.', relatedFiles: ['src/math.js'], fileScope: ['src/math.js'], dependencies: [], children: [], executionState: 'ready' as const, lastError: 'Activated as fallback for step-1.' },
        { id: 'step-2', title: 'Record fallback note', status: 'PENDING' as const, kind: 'search' as const, attempts: 0, details: 'No-op step after fallback.', dependencies: ['step-1'], children: [], executionState: 'blocked' as const },
      ],
    };
    const interruptedState = { version: '1' as const, revision: 1, phase: 'RETRYING' as const, outcome: 'RUNNING' as const, currentStepId: 'step-1-fallback', activeStepIds: [], readyStepIds: ['step-1-fallback'], completedStepIds: [], failedStepIds: ['step-1'], blockedStepIds: ['step-2'], invalidResponseAttempts: 0, message: 'Activated fallback step(s): step-1-fallback.', consistencyErrors: [] };
    await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a - b;\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n', 'utf8');
    const resumedExecution = await executePlannerPlan(
      config,
      new Map([['stub', provider]]),
      session,
      {
        promptHistory: ['生成一个会在 partial window 中断并走 fallback 的计划'],
        explicitFiles: ['src/math.js', 'tests/check-math.js'],
        pastedSnippets: [],
        resumedFrom: session.dir,
      },
      interruptedPlan,
      interruptedState,
      {
        classifyPlannerStep,
        updatePlannerStep,
      },
      {
        lockTable: { version: '1', revision: 1, entries: [{ path: 'src/math.js', mode: 'guarded_read', ownerStepId: 'step-1', revision: 1 }, { path: 'src/notes.txt', mode: 'write_locked', ownerStepId: 'step-unrelated', revision: 1 }] },
        executionState: { version: '1', revision: 1, executionPhase: 'recovering', plannerPhase: 'RETRYING', outcome: 'RUNNING', activeStepIds: [], readyStepIds: ['step-1-fallback'], completedStepIds: [], failedStepIds: ['step-1'], blockedStepIds: ['step-2'], degradedStepIds: [], currentWaveStepIds: [], lastCompletedWaveStepIds: [], selectedWaveStepIds: ['step-1-fallback'], interruptedStepIds: ['step-1-fallback'], resumeStrategy: 'resume_fallback_path', lastEventType: 'FALLBACK_ACTIVATED', lastEventReason: 'continuing fallback recovery through step-1-fallback.', strategy: 'serial', epoch: 1, currentStepId: 'step-1-fallback', message: 'Activated fallback step(s): step-1-fallback.', recoverySourceStepId: 'step-1', recoveryStepId: 'step-1-fallback', recoverySubgraphStepIds: ['step-1', 'step-1-fallback', 'step-2'], lockResumeMode: 'drop_unrelated_writes', planningWindowState: 'executing', recoveryReason: 'Activated fallback step(s): step-1-fallback.' },
      },
    );

    assert.equal(resumedExecution.state.outcome, 'DONE');
    assert.equal(fallbackExecutions, 1);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const resumedExecutionState = JSON.parse(await readFile(path.join(session.dir, 'execution.state.json'), 'utf8')) as {
      resumeStrategy?: string;
      planningWindowState?: string;
    };
    assert.equal(resumedExecutionState.resumeStrategy, 'resume_fallback_path');
    assert.equal(resumedExecutionState.planningWindowState, 'completed_waiting_append');
    const resumedPlan = JSON.parse(await readFile(path.join(session.dir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string }> };
    assert.equal(resumedPlan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(resumedPlan.steps.find((step) => step.id === 'step-1-fallback')?.status, 'DONE');
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
