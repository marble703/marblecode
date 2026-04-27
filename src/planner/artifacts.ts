import path from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ContextBundle } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { appendSessionLog, resolveSessionDir, writeSessionArtifact, type SessionRecord } from '../session/index.js';
import type { ToolDefinition } from '../tools/types.js';
import type { PlannerExecutionGraph } from './graph.js';
import type { ExecutionLockTable } from './locks.js';
import type { PlannerExecutionArtifacts, PlannerExecutionStateArtifact } from './execution-types.js';
import type { PlannerContextPacket, PlannerPlan, PlannerPlanDeltaArtifact, PlannerRequestArtifact, PlannerSessionArtifacts, PlannerState } from './types.js';
import { countSnippetLines } from './utils.js';

export function buildContextPacket(
  prompt: string,
  request: PlannerRequestArtifact,
  context: ContextBundle,
  maxSteps: number,
  revision: number,
  tools: ToolDefinition[],
): PlannerContextPacket {
  return {
    version: '1',
    objective: prompt,
    request: prompt,
    explicitFiles: request.explicitFiles,
    pastedSnippets: request.pastedSnippets.map((snippet, index) => `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}] ${snippet}`),
    queryTerms: context.queryTerms,
    contextItems: context.items.map((item) => ({
      path: item.path,
      source: item.source,
      reason: item.reason,
    })),
    constraints: {
      readOnly: true,
      allowedTools: tools.map((tool) => tool.name),
      maxSteps,
    },
    planRevision: revision,
  };
}

export async function writePlannerArtifacts(
  session: SessionRecord,
  request: PlannerRequestArtifact,
  context: ContextBundle,
  contextPacket: PlannerContextPacket,
  plan: PlannerPlan,
  state: PlannerState,
): Promise<void> {
  await writeSessionArtifact(session, 'planner.request.json', JSON.stringify(request, null, 2));
  await writeSessionArtifact(session, 'planner.context.json', JSON.stringify(context, null, 2));
  await writeSessionArtifact(session, 'planner.context.packet.json', JSON.stringify(contextPacket, null, 2));
  await writeSessionArtifact(session, 'plan.json', JSON.stringify(plan, null, 2));
  await writeSessionArtifact(session, 'plan.state.json', JSON.stringify(state, null, 2));
}

export async function writePlannerExecutionArtifacts(
  session: SessionRecord,
  graph: PlannerExecutionGraph,
  lockTable: ExecutionLockTable,
  executionState: PlannerExecutionStateArtifact,
): Promise<void> {
  await writeSessionArtifact(session, 'execution.graph.json', JSON.stringify(graph, null, 2));
  await writeSessionArtifact(session, 'execution.locks.json', JSON.stringify(lockTable, null, 2));
  await writeSessionArtifact(
    session,
    'execution.state.json',
    JSON.stringify(executionState, null, 2),
  );
}

export async function writePlannerDeltaArtifact(
  session: SessionRecord,
  delta: PlannerPlanDeltaArtifact,
): Promise<string> {
  const fileName = `plan.delta.${delta.nextRevision}.json`;
  await writeSessionArtifact(session, fileName, JSON.stringify(delta, null, 2));
  return fileName;
}

export async function appendPlannerEvent(
  session: SessionRecord,
  event: Record<string, unknown>,
  redactSecrets: boolean,
): Promise<void> {
  await appendSessionLog(session, 'plan.events.jsonl', event, redactSecrets);
}

export async function appendPlannerStructuredLog(
  session: SessionRecord,
  record: Record<string, unknown>,
  redactSecrets: boolean,
): Promise<void> {
  await appendSessionLog(session, 'planner.log.jsonl', record, redactSecrets);
}

export async function resumePlannerSession(
  config: AppConfig,
  sessionRef: string | undefined,
  useLatest: boolean | undefined,
): Promise<SessionRecord> {
  const dir = await resolveSessionDir(config, sessionRef, useLatest);
  return {
    id: path.basename(dir),
    dir,
  };
}

export async function loadPlannerSessionArtifacts(sessionDir: string): Promise<PlannerSessionArtifacts> {
  const [requestRaw, planRaw, stateRaw] = await Promise.all([
    readFile(path.join(sessionDir, 'planner.request.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.state.json'), 'utf8'),
  ]);

  return {
    request: JSON.parse(requestRaw) as PlannerRequestArtifact,
    plan: JSON.parse(planRaw) as PlannerPlan,
    state: JSON.parse(stateRaw) as PlannerState,
  };
}

export async function loadPlannerExecutionArtifacts(sessionDir: string): Promise<PlannerExecutionArtifacts> {
  const [planRaw, stateRaw, graphRaw, locksRaw, executionStateRaw] = await Promise.all([
    readFile(path.join(sessionDir, 'plan.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.state.json'), 'utf8'),
    readFile(path.join(sessionDir, 'execution.graph.json'), 'utf8'),
    readFile(path.join(sessionDir, 'execution.locks.json'), 'utf8'),
    readFile(path.join(sessionDir, 'execution.state.json'), 'utf8'),
  ]);

  return {
    plan: JSON.parse(planRaw) as PlannerPlan,
    state: JSON.parse(stateRaw) as PlannerState,
    graph: JSON.parse(graphRaw) as PlannerExecutionGraph,
    lockTable: JSON.parse(locksRaw) as ExecutionLockTable,
    executionState: JSON.parse(executionStateRaw) as PlannerExecutionStateArtifact,
  };
}
