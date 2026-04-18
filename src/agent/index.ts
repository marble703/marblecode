import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { previewPatch, applyPatch, rollbackPatch } from '../patch/apply.js';
import { parsePatchDocument } from '../patch/codec.js';
import type { PatchApplyResult, PatchDocument } from '../patch/types.js';
import type { ModelProvider, ModelRequest } from '../provider/types.js';
import { routeTask } from '../router/index.js';
import { appendSessionLog, createSession, writeSessionArtifact } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { runVerifier, type VerifyResult } from '../verifier/index.js';
import { PolicyEngine } from '../policy/index.js';

export interface RunAgentInput {
  prompt: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  manualVerifierCommands: string[];
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
  tools: ReturnType<ToolRegistry['listDefinitions']>,
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
    systemPrompt: buildSystemPrompt(config.routing.maxSteps),
    messages: [
      {
        role: 'user',
        content: [
          `User request:\n${prompt}`,
          `Available tools:\n${toolText || '(none)'}`,
          context.selectionSummary,
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
    'If the user did not provide target files or the selected context is incomplete, search before editing with search_text, list_files, and read_file.',
    'Treat pasted snippets such as [Pasted ~12 lines #1] as first-class search clues for identifiers, errors, and nearby code.',
    'When using replace_file, newText must contain the full final file content, not a partial diff.',
    'Patch documents may contain multiple operations when one fix spans multiple files such as implementation, tests, config, or verifier docs.',
    'Prefer read_file before editing unless the file content is already fully present in context.',
    'Sensitive files such as .env are unavailable unless they were explicitly supplied.',
    'Project-scoped verification plans may live in .marblecode/verifier.md. If verifier analysis says the verification plan is stale, you may update that file.',
    'Patch responses must follow this schema:',
    '{"type":"patch","thought":"...","patch":{"version":"1","summary":"...","operations":[{"type":"replace_file","path":"src/file.ts","diff":"brief summary","newText":"full file contents"},{"type":"replace_file","path":"tests/file.test.ts","diff":"brief summary","newText":"full file contents"}]}}',
  ].join(' ');
}

function parseAgentStep(content: string): AgentStep {
  const parsed = JSON.parse(extractJsonObject(content)) as Record<string, unknown>;
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

function countSnippetLines(snippet: string): number {
  return snippet.split(/\r?\n/).filter((line) => line.length > 0).length || 1;
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

  if (!hadExplicitFiles) {
    hints.push('No --file was provided. Try rerunning with --file path/to/file or --paste for a pasted snippet.');
  }

  if (!hadContext) {
    hints.push('No useful context was selected. Try a more specific prompt or provide a file explicitly.');
  }

  hints.push('You can inspect the session artifacts and use the rollback command if needed.');

  return [`Patch apply failed: ${reason}`, ...hints].join(' ');
}
