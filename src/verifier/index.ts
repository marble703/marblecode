import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import type { ModelProvider } from '../provider/types.js';
import { analyzeVerifyFailures } from './analysis.js';
import { resolveVerifierCommands } from './commands.js';
import { executeVerifierCommands } from './execute.js';

export interface VerifyCommand {
  name: string;
  command: string;
  source: 'manual' | 'config' | 'markdown' | 'discovered';
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
  if (manualCommands.length === 0 && !config.verifier.enabled && !config.verifier.allowDiscovery) {
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

  const failures = await executeVerifierCommands(config, policy, commands);

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
