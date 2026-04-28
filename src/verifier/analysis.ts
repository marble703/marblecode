import { readFile } from 'node:fs/promises';
import type { AppConfig } from '../config/schema.js';
import { invokeWithRetry } from '../provider/retry.js';
import type { ModelProvider } from '../provider/types.js';
import { extractJsonObject } from '../shared/json-response.js';
import type { VerifyAnalysis, VerifyResult } from './index.js';

export async function analyzeVerifyFailures(
  config: AppConfig,
  result: VerifyResult,
  providers: Map<string, ModelProvider>,
  changedFiles: string[],
  manualCommands: string[],
): Promise<VerifyAnalysis | undefined> {
  const modelAlias = config.routing.planningModel;
  const modelConfig = config.models[modelAlias];
  if (!modelConfig) {
    return undefined;
  }

  const provider = providers.get(modelConfig.provider);
  if (!provider) {
    return undefined;
  }

  let verifierDefinition = '';
  try {
    verifierDefinition = await readFile(config.verifier.path, 'utf8');
  } catch {
    verifierDefinition = '';
  }

  try {
    const response = await invokeWithRetry(config, provider, {
      providerId: modelConfig.provider,
      model: modelConfig.model,
      systemPrompt: [
        'You analyze project verifier failures for a coding agent.',
        'Decide whether the failure more likely means the code is wrong or the verifier definition should be updated.',
        'Return JSON only with keys shouldEditVerifier, summary, reason, confidence, suggestedVerifierChanges, suggestedCodeChanges.',
        'confidence must be one of low, medium, high.',
      ].join(' '),
      messages: [
        {
          role: 'user',
          content: buildVerifierAnalysisPrompt(config, result, changedFiles, manualCommands, verifierDefinition),
        },
      ],
      stream: false,
      maxOutputTokens: 1200,
      metadata: {
        mode: 'verifier-analysis',
      },
    });

    return parseVerifyAnalysis(response.content);
  } catch (error) {
    return {
      shouldEditVerifier: false,
      summary: 'Verifier analysis request failed.',
      reason: error instanceof Error ? error.message : String(error),
      confidence: 'low',
      suggestedVerifierChanges: [],
      suggestedCodeChanges: [],
      raw: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildVerifierAnalysisPrompt(
  config: AppConfig,
  result: VerifyResult,
  changedFiles: string[],
  manualCommands: string[],
  verifierDefinition: string,
): string {
  return [
    `Workspace: ${config.workspaceRoot}`,
    `Changed files: ${changedFiles.length > 0 ? changedFiles.join(', ') : '(none recorded)'}`,
    `Manual verifier commands: ${manualCommands.length > 0 ? manualCommands.join(' | ') : '(none)'}`,
    `Verifier markdown path: ${config.verifier.path}`,
    `Verifier markdown:\n${truncateForPrompt(verifierDefinition, 8000) || '(missing)'}`,
    `Executed commands:\n${JSON.stringify(result.commands, null, 2)}`,
    `Failures:\n${JSON.stringify(result.failures.map((failure) => ({
      ...failure,
      stdout: truncateForPrompt(failure.stdout, 4000),
      stderr: truncateForPrompt(failure.stderr, 4000),
    })), null, 2)}`,
    'If the verifier command looks stale, over-broad, platform-mismatched, or missing prerequisites, set shouldEditVerifier=true.',
    'If the command is reasonable and the output points to a real code regression, set shouldEditVerifier=false.',
  ].join('\n\n');
}

function truncateForPrompt(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function parseVerifyAnalysis(content: string): VerifyAnalysis {
  const parsed = JSON.parse(extractJsonObject(content)) as Record<string, unknown>;
  const confidence = parsed.confidence;
  return {
    shouldEditVerifier: Boolean(parsed.shouldEditVerifier),
    summary: String(parsed.summary ?? ''),
    reason: String(parsed.reason ?? ''),
    confidence: confidence === 'high' || confidence === 'medium' || confidence === 'low' ? confidence : 'low',
    suggestedVerifierChanges: toStringArray(parsed.suggestedVerifierChanges),
    suggestedCodeChanges: toStringArray(parsed.suggestedCodeChanges),
    raw: content,
  };
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === 'string');
}
