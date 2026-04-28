import { buildContext } from '../context/index.js';
import type { AppConfig } from '../config/schema.js';
import { rollbackPatch } from '../patch/apply.js';
import type { PatchApplyResult } from '../patch/types.js';
import type { ModelProvider } from '../provider/types.js';
import { routeTask } from '../router/index.js';
import { createSession, writeSessionArtifact } from '../session/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { PolicyEngine } from '../policy/index.js';
import { countSnippetLines } from './model.js';
import { runAgentRuntime } from './runtime.js';

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

  return runAgentRuntime(config, session, provider, policy, route, modelConfig, context, providers, tools, input);
}

export async function tryRollback(
  config: AppConfig,
  rollback: PatchApplyResult['rollback'],
): Promise<void> {
  const policy = new PolicyEngine(config);
  await rollbackPatch(config.workspaceRoot, rollback, policy);
}
