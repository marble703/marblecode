import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { routeTask } from '../router/index.js';
import { createSession } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import {
  appendPlannerEvent,
  buildContextPacket,
  loadPlannerSessionArtifacts,
  resumePlannerSession,
  writePlannerArtifacts,
} from './artifacts.js';
import type { PlannerSessionArtifacts } from './types.js';
import { runPlannerLoop } from './loop.js';
import {
  buildPlannerRequestArtifact,
  determineNextRevision,
  initializePlannerPlan,
  initializePlannerState,
  isTerminalOutcome,
  type RunPlannerInput,
  type RunPlannerResult,
} from './runtime.js';
import { refreshPlannerStateFromPlan } from './state.js';

export async function runPlanner(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  input: RunPlannerInput,
): Promise<RunPlannerResult> {
  const resumed = input.resumeSessionRef || input.useLatestSession;
  const session = resumed ? await resumePlannerSession(config, input.resumeSessionRef, input.useLatestSession) : await createSession(config);
  const prior = resumed ? await loadPlannerSessionArtifacts(session.dir) : undefined;

  const requestArtifact = buildPlannerRequestArtifact(input, session.dir, prior);
  if (requestArtifact.promptHistory.length === 0) {
    throw new Error('A prompt is required for a new plan, or provide --session/--last to resume an existing plan.');
  }

  const combinedPrompt = requestArtifact.promptHistory.join('\n\nAdditional planner input:\n');
  const route = routeTask(combinedPrompt, config);

  const context = await buildContext(
    {
      prompt: combinedPrompt,
      explicitFiles: requestArtifact.explicitFiles,
      pastedSnippets: requestArtifact.pastedSnippets,
    },
    config,
    new PolicyEngine(config, {
      grantedReadPaths: requestArtifact.explicitFiles,
      grantedWritePaths: requestArtifact.explicitFiles,
    }),
  );

  const nextRevision = determineNextRevision(input.prompt, prior);
  const toolDefinitions = tools.listDefinitions();
  const contextPacket = buildContextPacket(combinedPrompt, requestArtifact, context, route.maxSteps, nextRevision, toolDefinitions);
  let plan = initializePlannerPlan(prior?.plan, nextRevision, contextPacket.objective);
  let state = refreshPlannerStateFromPlan(plan, initializePlannerState(prior?.state, nextRevision, input.prompt, Boolean(prior)));

  await writePlannerArtifacts(session, requestArtifact, context, contextPacket, plan, state);
  await appendPlannerEvent(session, {
    type: prior ? (input.prompt.trim() ? 'planner_replanned' : 'planner_resumed') : 'planner_started',
    revision: nextRevision,
    prompt: input.prompt || '(resume)',
    resumedFrom: requestArtifact.resumedFrom,
  }, config.session.redactSecrets);

  if (prior && !input.prompt.trim() && isTerminalOutcome(prior.state.outcome)) {
    if (prior.state.outcome !== 'RUNNING') {
      return {
        status: prior.state.outcome === 'DONE' ? 'completed' : prior.state.outcome === 'NEEDS_INPUT' ? 'needs_input' : prior.state.outcome === 'CANCELLED' ? 'cancelled' : 'failed',
        sessionDir: session.dir,
        message: prior.state.message,
      };
    }
  }

  return runPlannerLoop(
    config,
    providers,
    tools,
    session,
    input,
    requestArtifact,
    combinedPrompt,
    route,
    context,
    contextPacket,
    plan,
    state,
    nextRevision,
  );
}
