import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { createInitialTuiState } from '../../src/tui/agent-repl.js';
import { applyTuiCommand } from '../../src/tui/commands.js';
import { loadPlannerEvents, loadPlannerSessionSummary, loadPlannerView } from '../../src/planner/view-model.js';
import { listRecentSessionEntries } from '../../src/session/index.js';
import { executeTuiAction, inspectPlannerStep, resolvePlannerChildSession } from '../../src/tui/session-actions.js';
import { listRecentSessions } from '../../src/tui/recent-sessions.js';
import { refreshTuiState } from '../../src/tui/state.js';
import { resolvePlannerSessionDir } from '../../src/session/index.js';
import {
  createExecutionState,
  createPlannerPlan,
  createPlannerState,
  withWorkspace,
  writePlannerArtifacts,
  writePlannerEvents,
} from './helpers.js';
import type { ManualSuiteCase } from './types.js';

export function createTuiCases(): ManualSuiteCase[] {
  return [
    { name: 'planner session resolution', run: testPlannerSessionResolution },
    { name: 'interactive tui command parsing', run: testInteractiveTuiCommandParsing },
    { name: 'interactive tui command errors', run: testInteractiveTuiCommandErrors },
    { name: 'recent session summaries', run: testRecentSessionSummaries },
    { name: 'tui state refresh hydrates planner view', run: testTuiStateRefreshHydratesPlannerView },
    { name: 'tui planner session actions', run: testTuiPlannerSessionActions },
    { name: 'planner view tolerates partial artifacts', run: testPlannerViewToleratesPartialArtifacts },
    { name: 'planner view loads delta and feedback artifacts', run: testPlannerViewLoadsDeltaAndFeedbackArtifacts },
    { name: 'planner view loads replan rejection artifacts', run: testPlannerViewLoadsReplanRejectionArtifacts },
    { name: 'planner view normalizes timeline events', run: testPlannerViewNormalizesTimelineEvents },
    { name: 'planner read-model api exposes raw and normalized events', run: testPlannerReadModelApiExposesRawAndNormalizedEvents },
    { name: 'planner session summary includes execution metadata', run: testPlannerSessionSummaryIncludesExecutionMetadata },
    { name: 'session entries stay storage scoped', run: testSessionEntriesStayStorageScoped },
  ];
}

async function testPlannerSessionResolution(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-00-000Z');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-01-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await writeFile(path.join(childSessionDir, 'request.json'), '{}', 'utf8');
    await writePlannerArtifacts(plannerSessionDir, {
      plan: createPlannerPlan({ summary: '', steps: [] }),
      planState: createPlannerState({ outcome: 'DONE', phase: 'PENDING', currentStepId: null }),
    });
    await writePlannerEvents(plannerSessionDir, [{ type: 'planner_finished' }]);

    const resolved = await resolvePlannerSessionDir(config, undefined, true);
    assert.equal(resolved, plannerSessionDir);
  });
}

async function testInteractiveTuiCommandParsing(): Promise<void> {
  let state = createInitialTuiState();
  state = applyTuiCommand(state, '/mode execute').state;
  assert.equal(state.mode, 'execute');
  state = applyTuiCommand(state, '/workspace /tmp/example-workspace').state;
  assert.equal(state.workspaceRoot, '/tmp/example-workspace');
  state = applyTuiCommand(state, '/files src/math.js tests/check-math.js').state;
  assert.deepEqual(state.explicitFiles, ['src/math.js', 'tests/check-math.js']);
  state = applyTuiCommand(state, '/add-file src/router.js').state;
  assert.deepEqual(state.explicitFiles, ['src/math.js', 'tests/check-math.js', 'src/router.js']);
  state = applyTuiCommand(state, '/remove-file tests/check-math.js').state;
  assert.deepEqual(state.explicitFiles, ['src/math.js', 'src/router.js']);
  state = applyTuiCommand(state, '/verify npm test').state;
  assert.deepEqual(state.manualVerifierCommands, ['npm test']);
  state = applyTuiCommand(state, '/yes on').state;
  assert.equal(state.autoApprove, true);
  state = applyTuiCommand(state, '/clear-files').state;
  assert.deepEqual(state.explicitFiles, []);
  state = {
    ...state,
    recentSessions: [
      { id: 'planner-1', dir: '/tmp/session-1', isPlanner: true, summary: 'Fix router', outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-1' },
      { id: 'child-1', dir: '/tmp/session-2', isPlanner: false, summary: 'Fix math' },
    ],
  };
  state = applyTuiCommand(state, '/open 1').state;
  assert.equal(state.lastSessionDir, '/tmp/session-1');
  const resume = applyTuiCommand(state, '/resume');
  assert.equal(resume.action?.type, 'resume_planner');
  assert.equal(resume.action?.executeSubtasks, true);
  assert.equal(resume.action?.sessionRef, '/tmp/session-1');
  const replan = applyTuiCommand(state, '/replan keep the current export surface');
  assert.equal(replan.action?.type, 'resume_planner');
  assert.equal(replan.action?.prompt, 'keep the current export surface');
  assert.equal(replan.action?.sessionRef, '/tmp/session-1');
  const follow = applyTuiCommand(state, '/follow last');
  assert.equal(follow.action?.type, 'follow_planner');
  assert.equal(follow.action?.useLatestSession, true);
  const inspect = applyTuiCommand(state, '/inspect step 1');
  assert.equal(inspect.action?.type, 'inspect_planner_step');
  assert.equal(inspect.action?.stepRef, '1');
  const openChild = applyTuiCommand(state, '/open-child step-1');
  assert.equal(openChild.action?.type, 'open_child_session');
  assert.equal(openChild.action?.stepRef, 'step-1');
  state = applyTuiCommand(state, '/show-state').state;
  assert.match(state.lastOutput, /mode: execute/);
  assert.match(state.lastOutput, /last session: \/tmp\/session-1/);
  state = applyTuiCommand(state, '/reset').state;
  assert.equal(state.mode, 'run');
  assert.equal(state.autoApprove, false);
  assert.equal(state.workspaceRoot, '/tmp/example-workspace');
  assert.deepEqual(state.pastedSnippets, []);
  assert.equal(state.lastSessionDir, null);
  assert.equal(state.plannerView, null);
}

async function testInteractiveTuiCommandErrors(): Promise<void> {
  let state = createInitialTuiState('/tmp/tui-errors');

  let result = applyTuiCommand(state, '/resume');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Switch to \/mode plan or \/mode execute/);

  result = applyTuiCommand(state, '/replan');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Switch to \/mode plan or \/mode execute/);

  result = applyTuiCommand(state, '/open');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Provide a session index or path/);

  result = applyTuiCommand(state, '/unknown-command');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Unknown command/);

  state = {
    ...state,
    mode: 'plan',
  };

  result = applyTuiCommand(state, '/replan');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Provide additional planner input/);

  result = applyTuiCommand(state, '/inspect wave 1');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Use \/inspect step/);

  result = applyTuiCommand(state, '/open-child');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /Provide a planner step id or index/);

  state = {
    ...state,
    recentSessions: [
      { id: 'child-1', dir: '/tmp/child-1', isPlanner: false, summary: 'child session' },
      { id: 'planner-1', dir: '/tmp/planner-1', isPlanner: true, summary: 'planner session', outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-1' },
    ],
  };

  result = applyTuiCommand(state, '/resume 1');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /is not a planner session/);

  result = applyTuiCommand(state, '/follow 99');
  assert.equal(result.action, undefined);
  assert.match(result.state.lastOutput, /No session found for 99/);

  result = applyTuiCommand(state, '/resume');
  assert.equal(result.action?.type, 'resume_planner');
  assert.equal(result.action?.sessionRef, '/tmp/planner-1');
}

async function testRecentSessionSummaries(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-01-000Z');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-00-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await writePlannerArtifacts(plannerSessionDir, {
      plannerRequest: { promptHistory: ['Refactor the router module'] },
      plan: createPlannerPlan({ summary: 'Refactor router safely', steps: [] }),
      planState: createPlannerState({ outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-2' }),
    });
    await writePlannerEvents(plannerSessionDir, [{ type: 'planner_started' }]);
    await writeFile(path.join(childSessionDir, 'request.json'), JSON.stringify({ prompt: 'Fix the add function' }), 'utf8');

    const sessions = await listRecentSessions(config, 4);
    assert.equal(sessions[0]?.isPlanner, true);
    assert.equal(sessions[0]?.summary, 'Refactor router safely');
    assert.equal(sessions[0]?.outcome, 'RUNNING');
    assert.equal(sessions[0]?.phase, 'PLANNING');
    assert.equal(sessions[0]?.currentStepId, 'step-2');
    assert.equal(sessions[1]?.isPlanner, false);
    assert.equal(sessions[1]?.summary, 'Fix the add function');
  });
}

async function testTuiStateRefreshHydratesPlannerView(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-01-000Z');
    await writePlannerArtifacts(sessionDir, {
      plan: createPlannerPlan({ summary: 'Hydrate planner panel', steps: [] }),
      planState: createPlannerState({ outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-1' }),
    });
    await writePlannerEvents(sessionDir, [{ type: 'planner_started' }]);

    const state = await refreshTuiState(undefined, {
      ...createInitialTuiState(workspaceRoot),
      workspaceRoot,
      lastSessionDir: sessionDir,
    });

    assert.equal(state.recentSessions[0]?.dir, sessionDir);
    assert.equal(state.plannerView?.summary, 'Hydrate planner panel');
    assert.equal(state.plannerView?.currentStepId, 'step-1');
    assert.equal(config.workspaceRoot, workspaceRoot);
  });
}

async function testTuiPlannerSessionActions(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-08-000Z');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-09-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await writePlannerArtifacts(plannerSessionDir, {
      plan: createPlannerPlan({
        summary: 'Inspect planner actions',
        steps: [
          {
            id: 'step-1',
            title: 'Inspect router flow',
            status: 'DONE',
            kind: 'code',
            details: 'Check router logic',
            relatedFiles: ['src/router.ts'],
            children: [],
          },
        ],
      }),
      planState: createPlannerState({ outcome: 'RUNNING', phase: 'PATCHING', currentStepId: 'step-1' }),
    });
    await writePlannerEvents(plannerSessionDir, [{ type: 'subtask_completed', stepId: 'step-1', sessionDir: childSessionDir, changedFiles: ['src/router.ts'] }]);
    await writeFile(path.join(plannerSessionDir, 'subtask.step-1.json'), JSON.stringify({ ok: true }), 'utf8');
    await writeFile(path.join(childSessionDir, 'request.json'), JSON.stringify({ prompt: 'Fix router flow' }), 'utf8');
    await writeFile(path.join(childSessionDir, 'verify.json'), JSON.stringify({ success: true, failures: [] }), 'utf8');

    const inspection = await inspectPlannerStep(plannerSessionDir, '1');
    assert.match(inspection, /Step: step-1/);
    assert.match(inspection, /Files: src\/router.ts/);
    assert.match(inspection, /Artifacts: subtask.step-1.json/);
    assert.match(inspection, /Child session:/);

    const child = await resolvePlannerChildSession(plannerSessionDir, 'step-1');
    assert.equal(child.sessionDir, childSessionDir);
    assert.match(child.summary, /Prompt: Fix router flow/);
    assert.match(child.summary, /Verify: passed/);

    const baseState = {
      ...createInitialTuiState(workspaceRoot),
      workspaceRoot,
    };
    const follow = await executeTuiAction(undefined, baseState, {
      type: 'follow_planner',
      pollMs: 250,
      sessionRef: plannerSessionDir,
    });
    assert.equal(follow.followSessionDir, plannerSessionDir);
    assert.equal(follow.followPollMs, 250);
    assert.equal(follow.state.lastSessionDir, plannerSessionDir);

    const inspectAction = await executeTuiAction(undefined, baseState, {
      type: 'inspect_planner_step',
      stepRef: 'step-1',
      sessionRef: plannerSessionDir,
    });
    assert.match(inspectAction.state.lastOutput, /Inspect router flow/);

    const childAction = await executeTuiAction(undefined, baseState, {
      type: 'open_child_session',
      stepRef: 'step-1',
      sessionRef: plannerSessionDir,
    });
    assert.equal(childAction.state.lastSessionDir, childSessionDir);
    assert.match(childAction.state.lastOutput, /Changed files: src\/router.ts/);
  });
}

async function testPlannerViewToleratesPartialArtifacts(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-02-000Z');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'plan.json'),
      JSON.stringify({
        summary: 'Investigate router flow',
        steps: [{ id: 'step-1', title: 'Inspect router', status: 'PENDING', kind: 'search', children: [] }],
      }),
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'plan.state.json'),
      JSON.stringify({ phase: 'PLANNING', outcome: 'RUNNING', message: 'Searching', currentStepId: 'step-1', degradedStepIds: ['step-2'], degradedCompletion: false, consistencyErrors: [] }),
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'plan.events.jsonl'),
      `${JSON.stringify({ type: 'planner_started', prompt: 'Inspect router flow' })}\n{"type":"partial"`,
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'execution.state.json'),
      JSON.stringify({
        executionPhase: 'recovering',
        strategy: 'serial',
        epoch: 3,
        currentWaveStepIds: ['step-1'],
        lastCompletedWaveStepIds: ['step-0'],
        selectedWaveStepIds: ['step-1'],
        interruptedStepIds: ['step-1'],
        resumeStrategy: 'resume_fallback_path',
        lastEventType: 'FALLBACK_ACTIVATED',
        lastEventReason: 'Activated fallback for step-1.',
        activeLockOwnerStepIds: ['step-1'],
        preservedLockOwnerStepIds: ['step-0'],
        downgradedLockOwnerStepIds: ['step-1'],
        droppedLockOwnerStepIds: ['step-unrelated'],
        recoverySourceStepId: 'step-1',
        recoveryStepId: 'step-1-fallback',
        recoverySubgraphStepIds: ['step-1', 'step-1-fallback', 'step-2'],
        lockResumeMode: 'drop_unrelated_writes',
        recoveryReason: 'Activated fallback for step-1.',
      }),
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'execution.graph.json'),
      JSON.stringify({
        waves: [],
        edges: [
          { from: 'step-1', to: 'step-2', type: 'conflict', reason: 'conflict_domain', domain: 'api-contract' },
        ],
      }),
      'utf8',
    );

    const view = await loadPlannerView(sessionDir);
    assert.equal(view.summary, 'Investigate router flow');
    assert.equal(view.phase, 'PLANNING');
    assert.equal(view.outcome, 'RUNNING');
    assert.equal(view.executionPhase, 'recovering');
    assert.equal(view.strategy, 'serial');
    assert.equal(view.epoch, 3);
    assert.deepEqual(view.currentWaveStepIds, ['step-1']);
    assert.deepEqual(view.lastCompletedWaveStepIds, ['step-0']);
    assert.deepEqual(view.selectedWaveStepIds, ['step-1']);
    assert.deepEqual(view.interruptedStepIds, ['step-1']);
    assert.equal(view.resumeStrategy, 'resume_fallback_path');
    assert.equal(view.lastEventType, 'FALLBACK_ACTIVATED');
    assert.equal(view.degradedCompletion, false);
    assert.match(view.lastEventReason, /Activated fallback/);
    assert.deepEqual(view.activeLockOwnerStepIds, ['step-1']);
    assert.deepEqual((view as { preservedLockOwnerStepIds?: string[] }).preservedLockOwnerStepIds, ['step-0']);
    assert.deepEqual((view as { downgradedLockOwnerStepIds?: string[] }).downgradedLockOwnerStepIds, ['step-1']);
    assert.deepEqual((view as { droppedLockOwnerStepIds?: string[] }).droppedLockOwnerStepIds, ['step-unrelated']);
    assert.equal((view as { recoverySourceStepId?: string }).recoverySourceStepId, 'step-1');
    assert.deepEqual((view as { recoverySubgraphStepIds?: string[] }).recoverySubgraphStepIds, ['step-1', 'step-1-fallback', 'step-2']);
    assert.equal((view as { lockResumeMode?: string }).lockResumeMode, 'drop_unrelated_writes');
    assert.equal(view.recoveryStepId, 'step-1-fallback');
    assert.match(view.recoveryReason, /Activated fallback/);
    assert.deepEqual(view.degradedStepIds, ['step-2']);
    assert.equal(view.conflictEdges.length, 1);
    assert.equal(view.conflictEdges[0]?.reason, 'conflict_domain');
    assert.equal(view.conflictEdges[0]?.domain, 'api-contract');
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.fallbackEdges, []);
    assert.deepEqual(view.planDeltas, []);
    assert.equal(view.latestFeedback, null);
    assert.deepEqual(view.replanRejections, []);
    assert.match(view.terminalSummary, /unavailable/);
  });
}

async function testPlannerViewLoadsDeltaAndFeedbackArtifacts(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-03-000Z');
    await writePlannerArtifacts(sessionDir, {
      plan: createPlannerPlan({ revision: 3, summary: 'Rolling plan', isPartial: false, planningHorizon: { waveCount: 1 }, steps: [] }),
      planState: createPlannerState({ phase: 'PENDING', outcome: 'DONE', currentStepId: null, message: 'done', degradedStepIds: ['step-2'], degradedCompletion: true }),
    });
    await writePlannerEvents(sessionDir, [
      { type: 'plan_appended', revision: 3, stepCount: 1 },
      { type: 'planner_execution_finished', outcome: 'DONE', degradedCompletion: true, degradedStepIds: ['step-2'] },
    ]);
    await writeFile(path.join(sessionDir, 'planner.log.jsonl'), `${JSON.stringify({ type: 'planner_terminal', outcome: 'DONE', message: 'done' })}\n`, 'utf8');
    await writeFile(path.join(sessionDir, 'plan.delta.2.json'), JSON.stringify({ baseRevision: 1, nextRevision: 2, reason: 'planner_append', planningWindowWaves: 1, addedStepIds: ['step-2'], combinedIsPartial: true }), 'utf8');
    await writeFile(path.join(sessionDir, 'plan.delta.3.json'), JSON.stringify({ baseRevision: 2, nextRevision: 3, reason: 'planner_append', planningWindowWaves: 1, addedStepIds: ['step-3'], combinedIsPartial: false }), 'utf8');
    await writeFile(path.join(sessionDir, 'execution.feedback.json'), JSON.stringify({ planRevision: 3, executionEpoch: 2, changedFiles: ['src/math.js'], undeclaredChangedFiles: ['src/notes.txt'], verifyFailures: [], triggerReplan: true, replanReason: 'Undeclared changed files detected in wave: src/notes.txt' }), 'utf8');

    const view = await loadPlannerView(sessionDir);
    assert.equal(view.planRevision, 3);
    assert.equal(view.planIsPartial, false);
    assert.equal(view.degradedCompletion, true);
    assert.equal(view.planningHorizonWaveCount, 1);
    assert.equal(view.planDeltas.length, 2);
    assert.deepEqual(view.planDeltas.map((delta) => delta.nextRevision), [2, 3]);
    assert.equal(view.latestFeedback?.executionEpoch, 2);
    assert.deepEqual(view.latestFeedback?.undeclaredChangedFiles, ['src/notes.txt']);
    assert.equal(view.events.length, 2);
  });
}

async function testPlannerViewLoadsReplanRejectionArtifacts(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-04-000Z');
    await writePlannerArtifacts(sessionDir, {
      plan: createPlannerPlan({ revision: 2, summary: 'Replan session', steps: [] }),
      planState: createPlannerState({ phase: 'REPLANNING', outcome: 'RUNNING', message: 'replanning', currentStepId: 'step-2' }),
    });
    await writePlannerEvents(sessionDir, []);
    await writeFile(path.join(sessionDir, 'replan.rejected.step-2.json'), JSON.stringify({ failedStepId: 'step-2', errors: ['lock conflict', 'scope mismatch'] }), 'utf8');

    const view = await loadPlannerView(sessionDir);
    assert.equal(view.replanRejections.length, 1);
    assert.equal(view.replanRejections[0]?.stepId, 'step-2');
    assert.deepEqual(view.replanRejections[0]?.errors, ['lock conflict', 'scope mismatch']);
  });
}

async function testPlannerViewNormalizesTimelineEvents(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-05-000Z');
    await writePlannerArtifacts(sessionDir, {
      plan: createPlannerPlan({ revision: 2, summary: 'Timeline session', steps: [] }),
      planState: createPlannerState({ phase: 'REPLANNING', outcome: 'RUNNING', message: 'replanning', currentStepId: 'step-2' }),
    });
    await writePlannerEvents(sessionDir, [
      { type: 'plan_appended', revision: 2, stepCount: 1 },
      { type: 'planner_execution_window_completed', revision: 2, executedWaveCount: 1 },
      { type: 'execution_feedback_undeclared_files', epoch: 3, undeclaredFiles: ['src/notes.txt'] },
    ]);

    const view = await loadPlannerView(sessionDir);
    assert.equal(view.timeline.length, 3);
    assert.match(view.timeline[0]?.label ?? '', /plan appended/);
    assert.match(view.timeline[1]?.label ?? '', /execution window completed/);
    assert.match(view.timeline[2]?.label ?? '', /undeclared files/);
    assert.equal(view.timeline[2]?.epoch, 3);
  });
}

async function testPlannerReadModelApiExposesRawAndNormalizedEvents(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-06-000Z');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      path.join(sessionDir, 'plan.events.jsonl'),
      [
        JSON.stringify({ type: 'subtask_started', stepId: 'step-1', executor: 'coder' }),
        JSON.stringify({ type: 'execution_feedback_verify_failed', stepId: 'step-2', epoch: 4 }),
      ].join('\n') + '\n',
      'utf8',
    );

    const events = await loadPlannerEvents(sessionDir);
    assert.equal(events.events.length, 2);
    assert.equal(events.subtaskEvents.length, 1);
    assert.equal(events.timeline.length, 2);
    assert.match(events.timeline[1]?.label ?? '', /verify failed/);
  });
}

async function testPlannerSessionSummaryIncludesExecutionMetadata(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, '.agent', 'sessions', '2026-04-20T10-00-07-000Z');
    await writePlannerArtifacts(sessionDir, {
      plan: createPlannerPlan({ revision: 5, summary: 'Session summary metadata', isPartial: true, steps: [] }),
      planState: createPlannerState({ phase: 'PATCHING', outcome: 'RUNNING', currentStepId: 'step-3' }),
      executionState: createExecutionState({ executionPhase: 'executing_wave', epoch: 2, currentWaveStepIds: ['step-3'], lastCompletedWaveStepIds: [] }),
    });
    await writePlannerEvents(sessionDir, [{ type: 'planner_started', prompt: 'metadata' }]);

    const summary = await loadPlannerSessionSummary('2026-04-20T10-00-07-000Z', sessionDir);
    assert.equal(summary.executionPhase, 'executing_wave');
    assert.equal(summary.planRevision, 5);
    assert.equal(summary.planIsPartial, true);
    assert.equal(summary.currentStepId, 'step-3');
  });
}

async function testSessionEntriesStayStorageScoped(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-11-000Z');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-10-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await writePlannerArtifacts(plannerSessionDir, {
      plan: createPlannerPlan({ summary: 'Storage scoped planner entry', steps: [] }),
      planState: createPlannerState({ outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-1' }),
    });
    await writePlannerEvents(plannerSessionDir, [{ type: 'planner_started' }]);
    await writeFile(path.join(childSessionDir, 'request.json'), JSON.stringify({ prompt: 'Child prompt' }), 'utf8');

    const entries = await listRecentSessionEntries(config, 4);
    assert.equal(entries[0]?.isPlanner, true);
    assert.equal(entries[0]?.id, '2026-04-20T10-00-11-000Z');
    assert.equal('summary' in (entries[0] ?? {}), false);
    assert.equal(entries[1]?.isPlanner, false);
    assert.equal(entries[1]?.id, '2026-04-20T10-00-10-000Z');
    assert.equal('summary' in (entries[1] ?? {}), false);

    const sessions = await listRecentSessions(config, 4);
    assert.equal(sessions[0]?.summary, 'Storage scoped planner entry');
    assert.equal(sessions[1]?.summary, 'Child prompt');
  });
}
