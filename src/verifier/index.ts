import { exec as execCallback } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { loadMarkdownVerifierSteps, selectMarkdownVerifierSteps } from './markdown.js';

const exec = promisify(execCallback);

export interface VerifyCommand {
  name: string;
  command: string;
  source: 'manual' | 'config' | 'markdown';
  description: string;
  when: string;
  paths: string[];
  platforms: string[];
  optional: boolean;
  timeoutMs: number;
}

export interface VerifyFailure {
  stage: 'verifier';
  name: string;
  command: string;
  source: VerifyCommand['source'];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  retryable: boolean;
  blocking: boolean;
}

export interface VerifyAnalysis {
  shouldEditVerifier: boolean;
  summary: string;
  reason: string;
  confidence: 'low' | 'medium' | 'high';
  suggestedVerifierChanges: string[];
  suggestedCodeChanges: string[];
  raw: string;
}

export interface VerifyResult {
  success: boolean;
  commands: VerifyCommand[];
  failures: VerifyFailure[];
  analysis?: VerifyAnalysis;
}

export interface RunVerifierOptions {
  changedFiles?: string[];
  manualCommands?: string[];
  providers?: Map<string, ModelProvider>;
}

export async function runVerifier(
  config: AppConfig,
  policy: PolicyEngine,
  options: RunVerifierOptions = {},
): Promise<VerifyResult> {
  const manualCommands = options.manualCommands ?? [];
  if (manualCommands.length === 0 && !config.verifier.enabled) {
    return {
      success: true,
      commands: [],
      failures: [],
    };
  }

  const commands = await resolveVerifierCommands(config, options.changedFiles ?? [], manualCommands);
  if (commands.length === 0) {
    return {
      success: true,
      commands,
      failures: [],
    };
  }

  const failures: VerifyFailure[] = [];
  for (const step of commands) {
    try {
      policy.assertShellCommand(step.command);
      await exec(step.command, {
        cwd: config.workspaceRoot,
        env: policy.filterShellEnv(),
        timeout: step.timeoutMs,
        maxBuffer: config.policy.shell.maxBufferBytes,
      });
    } catch (error) {
      const execError = error as Error & {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      failures.push({
        stage: 'verifier',
        name: step.name,
        command: step.command,
        source: step.source,
        exitCode: typeof execError.code === 'number' ? execError.code : null,
        stdout: execError.stdout ?? '',
        stderr: execError.stderr ?? execError.message,
        retryable: true,
        blocking: !step.optional,
      });
    }
  }

  const result: VerifyResult = {
    success: failures.every((failure) => !failure.blocking),
    commands,
    failures,
  };

  if (!result.success && config.verifier.autoAnalyzeFailures && options.providers) {
    const analysis = await analyzeVerifyFailures(config, result, options.providers, options.changedFiles ?? [], manualCommands);
    if (analysis) {
      result.analysis = analysis;
    }
  }

  return result;
}

async function resolveVerifierCommands(
  config: AppConfig,
  changedFiles: string[],
  manualCommands: string[],
): Promise<VerifyCommand[]> {
  if (manualCommands.length > 0) {
    return manualCommands.map((command, index) => ({
      name: `manual-${index + 1}`,
      command,
      source: 'manual',
      description: 'CLI override verifier command.',
      when: 'Requested manually for this run.',
      paths: [],
      platforms: [],
      optional: false,
      timeoutMs: config.verifier.timeoutMs,
    }));
  }

  if (config.verifier.commands.length > 0) {
    return config.verifier.commands.map((command, index) => ({
      name: `config-${index + 1}`,
      command,
      source: 'config',
      description: 'Legacy config-defined verifier command.',
      when: 'Configured in JSON config.',
      paths: [],
      platforms: [],
      optional: false,
      timeoutMs: config.verifier.timeoutMs,
    }));
  }

  const markdownSteps = selectMarkdownVerifierSteps(
    await loadMarkdownVerifierSteps(config.verifier.path),
    changedFiles,
    process.platform,
  );
  return markdownSteps.map((step) => ({
    name: step.name,
    command: step.command,
    source: 'markdown',
    description: step.description,
    when: step.when,
    paths: step.paths,
    platforms: step.platforms,
    optional: step.optional,
    timeoutMs: step.timeoutMs ?? config.verifier.timeoutMs,
  }));
}

async function analyzeVerifyFailures(
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
    const response = await provider.invoke({
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

function extractJsonObject(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fencedMatch?.[1]) {
    return extractParsableJsonObject(fencedMatch[1].trim());
  }

  return extractParsableJsonObject(trimmed);
}

function extractParsableJsonObject(content: string): string {
  const balanced = extractFirstBalancedJsonObject(content);
  if (isParsableJson(balanced)) {
    return balanced;
  }

  const start = content.indexOf('{');
  if (start < 0) {
    return content;
  }

  for (let index = start; index < content.length; index += 1) {
    if (content[index] !== '}') {
      continue;
    }

    const candidate = content.slice(start, index + 1);
    if (isParsableJson(candidate)) {
      return candidate;
    }
  }

  return balanced;
}

function extractFirstBalancedJsonObject(content: string): string {
  const start = content.indexOf('{');
  if (start < 0) {
    return content;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (char === '{') {
      depth += 1;
      continue;
    }

    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return content.slice(start, index + 1);
      }
    }
  }

  return content.slice(start);
}

function isParsableJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}
