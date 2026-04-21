import type { ModelRequest } from '../provider/types.js';
import type { VerifyResult } from '../verifier/index.js';
import type { PlannerContextPacket, PlannerPlan, PlannerRequestArtifact, PlannerState, PlannerStep } from './types.js';
import { countSnippetLines } from './utils.js';

export function buildPlannerNodeReplanRequest(
  providerId: string,
  model: string,
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  state: PlannerState,
  failedStep: PlannerStep,
  failureMessage: string,
): ModelRequest {
  return {
    providerId,
    model,
    systemPrompt: [
      'You repair planner execution failures for a coding host.',
      'Return JSON only.',
      'Return a full type=plan object that keeps completed steps intact and replans the failed step plus any downstream steps.',
      'Do not return patches.',
      'Prefer preserving existing step ids for already completed steps.',
    ].join(' '),
    messages: [
      {
        role: 'user',
        content: [
          `Original objective: ${requestArtifact.promptHistory[0] ?? ''}`,
          `Current planner summary: ${plan.summary}`,
          `Execution state: ${JSON.stringify(state, null, 2)}`,
          `Current plan: ${JSON.stringify(plan, null, 2)}`,
          `Failed step: ${JSON.stringify(failedStep, null, 2)}`,
          `Failure message: ${failureMessage}`,
          'Return a full updated plan JSON object only.',
        ].join('\n\n'),
      },
    ],
    stream: false,
    maxOutputTokens: 4000,
    metadata: {
      mode: 'planner-json-loop',
    },
  };
}

export function buildSubtaskPrompt(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  step: PlannerStep,
): string {
  return [
    `Original objective: ${requestArtifact.promptHistory[0] ?? ''}`,
    `Planner summary: ${plan.summary}`,
    `Execute planner step: ${step.title}`,
    step.details ? `Step details: ${step.details}` : '',
    step.relatedFiles && step.relatedFiles.length > 0 ? `Target files: ${step.relatedFiles.join(', ')}` : '',
    'Make the required code, test, or docs changes for this step only. Keep the change minimal and concrete.',
  ].filter(Boolean).join('\n');
}

export function buildVerifyRepairPrompt(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  verifyResult: VerifyResult,
): string {
  return [
    `Original objective: ${requestArtifact.promptHistory[0] ?? ''}`,
    `Planner summary: ${plan.summary}`,
    'Fix the remaining issues so verification passes.',
    `Verifier failures: ${JSON.stringify(verifyResult.failures, null, 2)}`,
    verifyResult.analysis ? `Verifier analysis: ${JSON.stringify(verifyResult.analysis, null, 2)}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildStepContextPacket(
  requestArtifact: PlannerRequestArtifact,
  plan: PlannerPlan,
  step: PlannerStep,
): PlannerContextPacket {
  return {
    version: '1',
    objective: step.title,
    request: requestArtifact.promptHistory.at(-1) ?? requestArtifact.promptHistory[0] ?? step.title,
    explicitFiles: step.relatedFiles ?? requestArtifact.explicitFiles,
    pastedSnippets: requestArtifact.pastedSnippets.map((snippet, index) => `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}] ${snippet}`),
    queryTerms: extractWordsForStep(step),
    contextItems: (step.relatedFiles ?? requestArtifact.explicitFiles).map((file) => ({
      path: file,
      source: 'planner-step',
      reason: step.title,
    })),
    constraints: {
      readOnly: false,
      allowedTools: ['read_file', 'list_files', 'search_text', 'run_shell', 'git_status', 'git_log', 'git_show', 'git_diff', 'git_diff_base'],
      maxSteps: plan.steps.length + 4,
    },
    planRevision: plan.revision,
    parentStepId: step.id,
  };
}

function extractWordsForStep(step: PlannerStep): string[] {
  return [...new Set(`${step.title} ${step.details ?? ''}`.match(/[a-zA-Z0-9_\u4e00-\u9fff]{2,}/g) ?? [])].slice(0, 12);
}
