import {
  assert,
  BranchingProvider,
  buildMathFixStep,
  buildNotesOnlyStep,
  createPlannerRegistry,
  path,
  PolicyEngine,
  readFile,
  runPlanner,
  withWorkspace,
  type ManualSuiteCase,
} from './planner-shared.js';

export function createPlannerRecoveryCases(): ManualSuiteCase[] {
  return [
    { name: 'planner execute retry recovery', run: testPlannerExecuteRetryRecovery },
    { name: 'planner execute fallback model', run: testPlannerExecuteFallbackModel },
    { name: 'planner execute graph fallback', run: testPlannerExecuteGraphFallback },
    { name: 'planner execute local replan', run: testPlannerExecuteLocalReplan },
    { name: 'planner execute rejects invalid local replan', run: testPlannerExecuteRejectsInvalidLocalReplan },
    { name: 'planner execute rejects lock-incompatible local replan', run: testPlannerExecuteRejectsLockIncompatibleLocalReplan },
    { name: 'planner execute blocked dependents', run: testPlannerExecuteBlockedDependents },
  ];
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
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string }> };
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
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as { steps: Array<{ id: string; status: string; executionState?: string; failureKind?: string; details?: string }> };
    assert.equal(plan.steps.find((step) => step.id === 'step-1')?.status, 'FAILED');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.status, 'PENDING');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.executionState, 'blocked');
    assert.equal(plan.steps.find((step) => step.id === 'step-2')?.failureKind, 'dependency');
    assert.match(plan.steps.find((step) => step.id === 'step-2')?.details ?? '', /Blocked by failed dependencies: step-1/);
  });
}
