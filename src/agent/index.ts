import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { previewPatch, applyPatch, rollbackPatch } from '../patch/apply.js';
import { parsePatchDocument } from '../patch/codec.js';
import type { PatchApplyResult, PatchDocument } from '../patch/types.js';
import type { ModelProvider, ModelRequest } from '../provider/types.js';
import { routeTask } from '../router/index.js';
import { appendSessionLog, createSession, writeSessionArtifact } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { runVerifier } from '../verifier/index.js';
import { PolicyEngine } from '../policy/index.js';

export interface RunAgentInput {
  prompt: string;
  explicitFiles: string[];
  autoApprove: boolean;
  confirm: (message: string) => Promise<boolean>;
}

export interface RunAgentResult {
  status: 'completed' | 'needs_intervention';
  sessionDir: string;
  changedFiles: string[];
  message: string;
}

type AgentStep =
  | {
      type: 'tool_call';
      thought?: string;
      tool: string;
      input: Record<string, unknown>;
    }
  | {
      type: 'patch';
      thought?: string;
      patch: PatchDocument;
    }
  | {
      type: 'final';
      thought?: string;
      message: string;
    };

export async function runAgent(
  config: AppConfig,
  providers: Map<string, ModelProvider>,
  tools: ToolRegistry,
  input: RunAgentInput,
): Promise<RunAgentResult> {
  const session = await createSession(config);
  const policy = new PolicyEngine(config);
  const route = routeTask(input.prompt, config);
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
    },
    config,
  );

  await writeSessionArtifact(session, 'context.json', JSON.stringify(context, null, 2));
  await writeSessionArtifact(
    session,
    'request.json',
    JSON.stringify(
      {
        prompt: input.prompt,
        explicitFiles: input.explicitFiles,
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
      const request = buildModelRequest(config, modelConfig.model, modelConfig.provider, input.prompt, context, transcript);
      const response = await provider.invoke(request);
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
        };
      }

      applyResult = await applyPatch(config.workspaceRoot, step.patch, policy);
      await writeSessionArtifact(session, 'rollback.json', JSON.stringify(applyResult.rollback, null, 2));
      const verifyResult = await runVerifier(config, policy);
      await writeSessionArtifact(session, 'verify.json', JSON.stringify(verifyResult, null, 2));

      if (verifyResult.success) {
        return {
          status: 'completed',
          sessionDir: session.dir,
          changedFiles: applyResult.changedFiles,
          message: step.patch.summary,
        };
      }

      repairAttempts += 1;
      transcript.push(`verifier:${JSON.stringify(verifyResult)}`);
      if (repairAttempts > route.maxAutoRepairAttempts) {
        return {
          status: 'needs_intervention',
          sessionDir: session.dir,
          changedFiles: applyResult.changedFiles,
          message: 'Verifier failed after the maximum number of repair attempts.',
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
      };
    }
  }

  return {
    status: 'needs_intervention',
    sessionDir: session.dir,
    changedFiles: [],
    message: 'Agent stopped before completing the task.',
  };
}

function buildModelRequest(
  config: AppConfig,
  model: string,
  providerId: string,
  prompt: string,
  context: Awaited<ReturnType<typeof buildContext>>,
  transcript: string[],
): ModelRequest {
  const contextText = context.items
    .map((item) => {
      const warning = item.warning ? `Warning: ${item.warning}\n` : '';
      return `File: ${item.path}\nReason: ${item.reason}\n${warning}${item.excerpt}`;
    })
    .join('\n\n---\n\n');

  return {
    providerId,
    model,
    systemPrompt: buildSystemPrompt(config.routing.maxSteps),
    messages: [
      {
        role: 'user',
        content: [
          `User request:\n${prompt}`,
          `Context:\n${contextText || '(no context selected)'}`,
          transcript.length > 0 ? `Transcript:\n${transcript.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ],
    stream: false,
    maxOutputTokens: 4000,
    metadata: {
      mode: 'mvp-json-loop',
    },
  };
}

function buildSystemPrompt(maxSteps: number): string {
  return [
    'You are a coding agent operating inside a secure local host.',
    `You may take at most ${maxSteps} steps before the host will stop you.`,
    'Valid response types are JSON objects with type = tool_call, patch, or final.',
    'Do not output prose outside JSON.',
    'Never request write_file. The host applies structured patches on your behalf.',
    'Sensitive files such as .env are unavailable unless they were explicitly supplied.',
    'Patch responses must follow this schema:',
    '{"type":"patch","thought":"...","patch":{"version":"1","summary":"...","operations":[{"type":"replace_file","path":"src/file.ts","diff":"brief summary","newText":"full file contents"}]}}',
  ].join(' ');
}

function parseAgentStep(content: string): AgentStep {
  const parsed = JSON.parse(content) as Record<string, unknown>;
  const type = parsed.type;
  if (type === 'tool_call') {
    return withOptionalThought(
      {
        type: 'tool_call',
        tool: String(parsed.tool),
        input: (parsed.input as Record<string, unknown>) ?? {},
      },
      parsed.thought,
    );
  }

  if (type === 'patch') {
    return withOptionalThought(
      {
        type: 'patch',
        patch: parsePatchDocument(JSON.stringify(parsed.patch)),
      },
      parsed.thought,
    );
  }

  if (type === 'final') {
    return withOptionalThought(
      {
        type: 'final',
        message: String(parsed.message ?? ''),
      },
      parsed.thought,
    );
  }

  throw new Error('Model response did not contain a valid agent step');
}

function withOptionalThought<T extends AgentStep>(step: T, thought: unknown): T {
  if (typeof thought === 'string') {
    return {
      ...step,
      thought,
    };
  }

  return step;
}

function renderPatchPreview(preview: Array<{ path: string; type: string; summary: string; preview: string }>): string {
  return preview
    .map((item) => [`[${item.type}] ${item.path}`, item.summary, item.preview].join('\n'))
    .join('\n\n');
}

export async function tryRollback(
  config: AppConfig,
  rollback: PatchApplyResult['rollback'],
): Promise<void> {
  const policy = new PolicyEngine(config);
  await rollbackPatch(config.workspaceRoot, rollback, policy);
}
