import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { applyPatch, isPatchBaseDriftError, previewPatch, rollbackPatch } from '../patch/apply.js';
import type { PatchApplyResult } from '../patch/types.js';
import type { ModelProvider } from '../provider/types.js';
import { invokeWithRetry } from '../provider/retry.js';
import { routeTask } from '../router/index.js';
import { appendSessionLog, createSession, writeSessionArtifact } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { runVerifier, type VerifyResult } from '../verifier/index.js';
import { PolicyEngine } from '../policy/index.js';
import { buildModelRequest, countSnippetLines } from './model.js';
import { parseAgentStep } from './parse.js';

export interface RunAgentInput {
  prompt: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  manualVerifierCommands: string[];
  autoApprove: boolean;
  confirm: (message: string) => Promise<boolean>;
  policyOptions?: {
    grantedReadPaths?: string[];
    grantedWritePaths?: string[];
    restrictWritePaths?: boolean;
    writePathValidator?: (targetPath: string) => void;
  };
  routeOverride?: {
    modelAlias: string;
    intent: 'question' | 'code' | 'planning';
    maxSteps: number;
    maxAutoRepairAttempts: number;
  };
}

export interface RunAgentResult {
  status: 'completed' | 'needs_intervention';
  sessionDir: string;
  changedFiles: string[];
  message: string;
  modelAlias: string;
}

export async function runAgent(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  const session = await createSession(config);
  const policy = new PolicyEngine(config, {
    grantedReadPaths: input.policyOptions?.grantedReadPaths ?? input.explicitFiles,
    grantedWritePaths: input.policyOptions?.grantedWritePaths ?? input.explicitFiles,
    ...(input.policyOptions?.restrictWritePaths ? { restrictWritePaths: true } : {}),
    ...(input.policyOptions?.writePathValidator ? { writePathValidator: input.policyOptions.writePathValidator } : {}),
  });
  const route = input.routeOverride ?? routeTask(input.prompt, config);
  const modelConfig = config.models[route.modelAlias];
  if (!modelConfig) {
    throw new Error(`Unknown model alias: ${route.modelAlias}`);
  }

  const provider = providers.get(modelConfig.provider);
  if (!provider) {
    throw new Error(`Provider ${modelConfig.provider} is not available`);
  }

  const context = await buildContext(
      {
        prompt: input.prompt,
        explicitFiles: input.explicitFiles,
        pastedSnippets: input.pastedSnippets,
      },
      config,
      policy,
  );

  await writeSessionArtifact(session, 'context.json', JSON.stringify(context, null, 2));
  await writeSessionArtifact(
    session,
    'request.json',
    JSON.stringify(
        {
          prompt: input.prompt,
          explicitFiles: input.explicitFiles,
          pastedSnippets: input.pastedSnippets.map(
            (snippet, index) => `[Pasted ~${countSnippetLines(snippet)} lines #${index + 1}] ${snippet}`,
          ),
          manualVerifierCommands: input.manualVerifierCommands,
          route,
        },
        null,
      2,
    ),
  );

  const transcript: string[] = [];
  let repairAttempts = 0;

  while (repairAttempts <= route.maxAutoRepairAttempts) {
    let stepCount = 0;
    let applyResult: PatchApplyResult | undefined;
    while (stepCount < route.maxSteps) {
      const request = buildModelRequest(
        config,
        modelConfig.model,
        modelConfig.provider,
        input.prompt,
        context,
        transcript,
        tools.listDefinitions(),
      );
      let response;
      try {
        response = await invokeWithRetry(config, provider, request, async (event) => {
          await appendSessionLog(
            session,
            'model.retries.jsonl',
            {
              mode: 'agent',
              attempt: event.attempt,
              maxAttempts: event.maxAttempts,
              delayMs: event.delayMs,
              reason: event.reason,
            },
            config.session.redactSecrets,
          );
        });
      } catch (error) {
        const message = buildProviderFailureMessage(error, config.session.modelRetryAttempts);
        await writeSessionArtifact(
          session,
          'model-error.json',
          JSON.stringify(
            {
              mode: 'agent',
              error: error instanceof Error ? error.message : String(error),
              retryAttempts: config.session.modelRetryAttempts,
            },
            null,
            2,
          ),
        );
        return {
          status: 'needs_intervention',
          sessionDir: session.dir,
          changedFiles: applyResult?.changedFiles ?? [],
          message,
          modelAlias: route.modelAlias,
        };
      }
      await appendSessionLog(
        session,
        'model.jsonl',
        {
          stopReason: response.stopReason,
          usage: response.usage,
          content: config.session.logPromptBodies ? response.content : '[omitted]',
        },
        config.session.redactSecrets,
      );

      const step = parseAgentStep(response.content);
      transcript.push(`assistant:${response.content}`);

      if (step.type === 'tool_call') {
        const toolResult = await tools.execute({ name: step.tool, input: step.input });
        await appendSessionLog(
          session,
          'tools.jsonl',
          {
            tool: step.tool,
            input: config.session.logToolBodies ? step.input : '[omitted]',
            result: config.session.logToolBodies ? toolResult : { ok: toolResult.ok },
          },
          config.session.redactSecrets,
        );
        transcript.push(`tool:${JSON.stringify({ tool: step.tool, result: toolResult })}`);
        stepCount += 1;
        continue;
      }

      if (step.type === 'final') {
        return {
          status: 'completed',
          sessionDir: session.dir,
          changedFiles: [],
          message: step.message,
          modelAlias: route.modelAlias,
        };
      }

      const preview = await previewPatch(config.workspaceRoot, step.patch);
      await writeSessionArtifact(session, 'patch.json', JSON.stringify(step.patch, null, 2));
      await writeSessionArtifact(
        session,
        'patch.preview.txt',
        preview.map((item) => `${item.summary}\n${item.preview}`).join('\n\n'),
      );

      const approved = input.autoApprove || (await input.confirm(renderPatchPreview(preview)));
      if (!approved) {
        return {
          status: 'needs_intervention',
          sessionDir: session.dir,
          changedFiles: [],
          message: 'Patch preview rejected by user.',
          modelAlias: route.modelAlias,
        };
      }

      try {
        applyResult = await applyPatch(config.workspaceRoot, step.patch, policy, `${session.dir}/backups`);
      } catch (error) {
        const message = buildApplyFailureMessage(error, input.explicitFiles.length > 0, context.items.length > 0);
        await writeSessionArtifact(
          session,
          'apply-error.json',
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
            explicitFiles: input.explicitFiles,
            contextItemCount: context.items.length,
          }, null, 2),
        );

        return {
          status: 'needs_intervention',
          sessionDir: session.dir,
          changedFiles: [],
          message,
          modelAlias: route.modelAlias,
        };
      }
      await writeSessionArtifact(session, 'rollback.json', JSON.stringify(applyResult.rollback, null, 2));
      await writeSessionArtifact(session, 'backups.json', JSON.stringify(applyResult.backupFiles, null, 2));
      const verifyResult = await runVerifier(config, policy, {
        changedFiles: applyResult.changedFiles,
        manualCommands: input.manualVerifierCommands,
        providers,
      });
      await writeSessionArtifact(session, 'verify.json', JSON.stringify(verifyResult, null, 2));
      if (verifyResult.analysis) {
        await writeSessionArtifact(session, 'verify.analysis.json', JSON.stringify(verifyResult.analysis, null, 2));
      }

      if (verifyResult.success) {
        return {
          status: 'completed',
          sessionDir: session.dir,
          changedFiles: applyResult.changedFiles,
          message: step.patch.summary,
          modelAlias: route.modelAlias,
        };
      }

      repairAttempts += 1;
      transcript.push(`verifier:${JSON.stringify(verifyResult)}`);
      if (repairAttempts > route.maxAutoRepairAttempts) {
        return {
          status: 'needs_intervention',
          sessionDir: session.dir,
          changedFiles: applyResult.changedFiles,
          message: buildVerifierFailureMessage(verifyResult),
          modelAlias: route.modelAlias,
        };
      }

      break;
    }

    if (stepCount >= route.maxSteps) {
      return {
        status: 'needs_intervention',
        sessionDir: session.dir,
        changedFiles: applyResult?.changedFiles ?? [],
        message: 'Agent reached the maximum step limit and needs user intervention.',
        modelAlias: route.modelAlias,
      };
    }
  }

  return {
    status: 'needs_intervention',
    sessionDir: session.dir,
    changedFiles: [],
    message: 'Agent stopped before completing the task.',
    modelAlias: route.modelAlias,
  };
}

function renderPatchPreview(preview: Array<{ path: string; type: string; summary: string; preview: string }>): string {
  return preview
    .map((item) => [`[${item.type}] ${item.path}`, item.summary, item.preview].join('\n'))
    .join('\n\n');
}

function buildVerifierFailureMessage(verifyResult: VerifyResult): string {
  const blockingFailures = verifyResult.failures.filter((failure) => failure.blocking);
  const analysis = verifyResult.analysis;
  const details = blockingFailures.length > 0
    ? ` Failed commands: ${blockingFailures.map((failure) => failure.command).join('; ')}.`
    : '';
  const analysisText = analysis
    ? ` Analysis: ${analysis.summary || analysis.reason}${analysis.shouldEditVerifier ? ' Consider updating .marblecode/verifier.md.' : ''}`
    : '';
  return `Verifier failed after the maximum number of repair attempts.${details}${analysisText}`;
}

export async function tryRollback(
  config: AppConfig,
  rollback: PatchApplyResult['rollback'],
): Promise<void> {
  const policy = new PolicyEngine(config);
  await rollbackPatch(config.workspaceRoot, rollback, policy);
}

function buildApplyFailureMessage(error: unknown, hadExplicitFiles: boolean, hadContext: boolean): string {
  const reason = error instanceof Error ? error.message : String(error);
  const hints: string[] = [];

  if (isPatchBaseDriftError(error)) {
    hints.push(`The baseline for ${error.filePath} changed after the patch was generated. Refresh context and regenerate the patch before retrying.`);
  }

  if (!hadExplicitFiles) {
    hints.push('No --file was provided. Try rerunning with --file path/to/file or --paste for a pasted snippet.');
  }

  if (!hadContext) {
    hints.push('No useful context was selected. Try a more specific prompt or provide a file explicitly.');
  }

  hints.push('You can inspect the session artifacts and use the rollback command if needed.');

  return [`Patch apply failed: ${reason}`, ...hints].join(' ');
}

function buildProviderFailureMessage(error: unknown, retryAttempts: number): string {
  const reason = error instanceof Error ? error.message : String(error);
  return `Model request failed after ${retryAttempts} retries. ${reason}`;
}
