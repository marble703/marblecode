import { appendSessionLog, writeSessionArtifact } from '../session/index.js';
import type { SessionRecord } from '../session/index.js';
import { applyPatch, previewPatch } from '../patch/apply.js';
import type { PatchApplyResult } from '../patch/types.js';
import { invokeWithRetry } from '../provider/retry.js';
import type { ModelProvider } from '../provider/types.js';
import { ToolRegistry } from '../tools/registry.js';
import { runVerifier } from '../verifier/index.js';
import type { AppConfig } from '../config/schema.js';
import type { PolicyEngine } from '../policy/index.js';
import { buildModelRequest } from './model.js';
import { buildApplyFailureMessage, buildProviderFailureMessage, buildVerifierFailureMessage, renderPatchPreview } from './messages.js';
import { parseAgentStep } from './parse.js';
import type { RunAgentInput, RunAgentResult } from './index.js';

export async function runAgentRuntime(
  config: AppConfig,
  session: SessionRecord,
  provider: ModelProvider,
  policy: PolicyEngine,
  route: NonNullable<RunAgentInput['routeOverride']>,
  modelConfig: { model: string; provider: string },
  context: Awaited<ReturnType<typeof import('../context/index.js').buildContext>>,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  input: RunAgentInput,
): Promise<RunAgentResult> {
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
