import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { applyTuiCommand, createInitialTuiState } from '../../src/tui/agent-repl.js';
import { loadPlannerView } from '../../src/tui/planner-view.js';
import { listRecentSessions, resolvePlannerSessionDir } from '../../src/session/index.js';
import { withWorkspace } from './helpers.js';
import type { ManualSuiteCase } from './types.js';

export function createTuiCases(): ManualSuiteCase[] {
  return [
    { name: 'planner session resolution', run: testPlannerSessionResolution },
    { name: 'interactive tui command parsing', run: testInteractiveTuiCommandParsing },
    { name: 'recent session summaries', run: testRecentSessionSummaries },
    { name: 'planner view tolerates partial artifacts', run: testPlannerViewToleratesPartialArtifacts },
  ];
}

async function testPlannerSessionResolution(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-00-000Z');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-01-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await mkdir(plannerSessionDir, { recursive: true });
    await writeFile(path.join(childSessionDir, 'request.json'), '{}', 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.json'), JSON.stringify({ summary: '', steps: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.state.json'), JSON.stringify({ outcome: 'DONE', phase: 'PENDING', currentStepId: null, consistencyErrors: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.events.jsonl'), JSON.stringify({ type: 'planner_finished' }) + '\n', 'utf8');

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
}

async function testRecentSessionSummaries(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-01-000Z');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-00-000Z');
    await mkdir(plannerSessionDir, { recursive: true });
    await mkdir(childSessionDir, { recursive: true });
    await writeFile(path.join(plannerSessionDir, 'plan.json'), JSON.stringify({ summary: 'Refactor router safely', steps: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.state.json'), JSON.stringify({ outcome: 'RUNNING', phase: 'PLANNING', currentStepId: 'step-2', consistencyErrors: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.events.jsonl'), JSON.stringify({ type: 'planner_started' }) + '\n', 'utf8');
    await writeFile(path.join(plannerSessionDir, 'planner.request.json'), JSON.stringify({ promptHistory: ['Refactor the router module'] }), 'utf8');
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
      JSON.stringify({ phase: 'PLANNING', outcome: 'RUNNING', message: 'Searching', currentStepId: 'step-1', consistencyErrors: [] }),
      'utf8',
    );
    await writeFile(
      path.join(sessionDir, 'plan.events.jsonl'),
      `${JSON.stringify({ type: 'planner_started', prompt: 'Inspect router flow' })}\n{"type":"partial"`,
      'utf8',
    );

    const view = await loadPlannerView(sessionDir);
    assert.equal(view.summary, 'Investigate router flow');
    assert.equal(view.phase, 'PLANNING');
    assert.equal(view.outcome, 'RUNNING');
    assert.equal(view.events.length, 1);
    assert.deepEqual(view.fallbackEdges, []);
    assert.match(view.terminalSummary, /unavailable/);
  });
}
