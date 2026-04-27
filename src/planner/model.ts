import type { ContextBundle } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import type { ModelRequest } from '../provider/types.js';
import type { ToolDefinition } from '../tools/types.js';
import type { PlannerContextPacket, PlannerPlan, PlannerState } from './types.js';

export function buildPlannerModelRequest(
  config: AppConfig,
  model: string,
  providerId: string,
  prompt: string,
  context: ContextBundle,
  transcript: string[],
  tools: ToolDefinition[],
  plan: PlannerPlan,
  state: PlannerState,
  contextPacket: PlannerContextPacket,
  executeSubtasks: boolean,
): ModelRequest {
  const contextText = context.items
    .map((item) => {
      const warning = item.warning ? `Warning: ${item.warning}\n` : '';
      return `File: ${item.path}\nSource: ${item.source}\nReason: ${item.reason}\n${warning}${item.excerpt}`;
    })
    .join('\n\n---\n\n');
  const toolText = tools
    .map((tool) => `- ${tool.name}: ${tool.description} input=${JSON.stringify(tool.inputSchema)}`)
    .join('\n');

  return {
    providerId,
    model,
    systemPrompt: buildPlannerSystemPrompt(config.routing.maxSteps, config.routing.planningWindowWaves, executeSubtasks),
    messages: [
      {
        role: 'user',
        content: [
          `Planning request:\n${prompt}`,
          executeSubtasks
            ? 'Execution mode: the host will execute code/test/verify steps after you return a valid plan. Return a structured plan first, then a final summary. Do not claim you cannot execute because the host handles execution.'
            : 'Execution mode: read-only planning only.',
          `Available tools:\n${toolText || '(none)'}`,
          context.selectionSummary,
          `Current plan state:\n${JSON.stringify(state, null, 2)}`,
          `Current plan:\n${JSON.stringify(plan, null, 2)}`,
          `Subtask context packet template:\n${JSON.stringify(contextPacket, null, 2)}`,
          `Context:\n${contextText || '(no context selected)'}`,
          transcript.length > 0 ? `Transcript:\n${transcript.join('\n')}` : '',
        ].filter(Boolean).join('\n\n'),
      },
    ],
    stream: false,
    maxOutputTokens: 4000,
    metadata: {
      mode: 'planner-json-loop',
    },
  };
}

function buildPlannerSystemPrompt(maxSteps: number, planningWindowWaves: number, executeSubtasks: boolean): string {
  return [
    'You are a planning agent operating inside a secure local host.',
    `You may take at most ${maxSteps} steps before the host will stop you.`,
    'This mode is read-only. You must never propose patches or code changes directly.',
    'Valid response types are JSON objects with type = tool_call, plan, plan_append, plan_update, or final.',
    'Do not output prose outside JSON.',
    'Use read_file, list_files, search_text, and git tools such as git_diff, git_status, git_log, git_show, and git_diff_base when you need more information before updating the plan.',
    'Treat pasted snippets such as [Pasted ~6 lines #1] as first-class search clues.',
    'Plan steps must use statuses from: PENDING, SEARCHING, PATCHING, VERIFYING, FAILED, DONE.',
    'Prefer step kinds search, code, test, and verify when they apply, and include relatedFiles whenever you can identify them.',
    'For executable write steps, include fileScope and accessMode when possible so the host can avoid conflicts and restrict writes safely.',
    'Use mustRunAfter or conflictsWith when two write steps should not run in the same execution wave.',
    'When different files are still logically coupled, include conflictDomains such as api-contract, db-schema, css-theme, routing-contract, build-config, or test-fixtures.',
    'You may also include optional step fields such as maxAttempts, fallbackStepIds, dependsOnFiles, producesFiles, ownershipTransfers, conflictsWith, conflictDomains, and failureTolerance when they help execution planning.',
    'For non-critical docs or auxiliary steps, you may set failureTolerance=degrade so the host can continue after a bounded failure.',
    `In execution mode, plan only the next ${planningWindowWaves} execution waves that are needed right now. If more work will remain after those waves, mark the plan with isPartial=true and include planningHorizon, openQuestions, and nextPlanningTriggers.`,
    'When extending an existing executed partial plan, return type=plan_append with only newly added steps. Do not resend or mutate already completed steps in a plan_append response.',
    'When the user asks for a plan, produce a structured plan with ordered steps, then optionally update step statuses as you search.',
    executeSubtasks
      ? 'The host will execute your code, test, and verify steps after you provide the plan. You must return a real plan object with non-empty steps before the final summary.'
      : 'The host will not execute steps in this mode; produce a read-only plan only.',
    'When you need the user to clarify something, return final with outcome NEEDS_INPUT.',
    'Never return type patch in planner mode.',
    'Plan responses must follow this schema:',
    '{"type":"plan","plan":{"version":"1","summary":"...","isPartial":true,"planningHorizon":{"waveCount":1},"nextPlanningTriggers":["after step-2 succeeds"],"steps":[{"id":"step-1","title":"Find router files","status":"PENDING","kind":"search","details":"...","dependencies":[],"children":[]},{"id":"step-2","title":"Update router","status":"PENDING","kind":"code","relatedFiles":["src/router.ts"],"fileScope":["src/router.ts"],"accessMode":"write","dependencies":["step-1"],"children":[]} ]}}',
    'Plan append responses must follow this schema:',
    '{"type":"plan_append","plan":{"version":"1","summary":"...","isPartial":false,"steps":[{"id":"step-3","title":"Run verification","status":"PENDING","kind":"verify","dependencies":["step-2"],"children":[]} ]}}',
    'Plan update responses must follow this schema:',
    '{"type":"plan_update","stepId":"step-1","status":"SEARCHING","message":"Searching router files","relatedFiles":["src/router.ts"]}',
    'Final responses must follow this schema:',
    '{"type":"final","outcome":"DONE","message":"Plan complete","summary":"..."}',
  ].join(' ');
}
