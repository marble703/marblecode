import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agent/index.js';
import type { AppConfig } from '../src/config/schema.js';
import { PolicyEngine } from '../src/policy/index.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/provider/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createBuiltinTools } from '../src/tools/builtins.js';

class SmokeProvider implements ModelProvider {
  public readonly id = 'smoke';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public async invoke(_request: ModelRequest): Promise<ModelResponse> {
    return {
      content: JSON.stringify({
        type: 'patch',
        thought: 'Replace the sample file content with the edited text.',
        patch: {
          version: '1',
          summary: 'Update the sample file.',
          operations: [
            {
              type: 'replace_file',
              path: 'sample.txt',
              diff: 'Change the sample text to prove patch application works.',
              newText: 'after\n',
            },
          ],
        },
      }),
    };
  }
}

async function main(): Promise<void> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'coding-agent-smoke-'));
  try {
    await writeFile(path.join(workspaceRoot, 'sample.txt'), 'before\n', 'utf8');

    const config: AppConfig = {
      workspaceRoot,
      providers: {
        smoke: {
          type: 'openai-compatible',
          baseUrl: 'https://example.invalid/v1',
          apiKeyEnv: 'SMOKE_UNUSED',
        },
      },
      models: {
        cheap: { provider: 'smoke', model: 'smoke-model' },
        code: { provider: 'smoke', model: 'smoke-model' },
        strong: { provider: 'smoke', model: 'smoke-model' },
      },
      routing: {
        defaultModel: 'cheap',
        codeModel: 'code',
        planningModel: 'strong',
        maxSteps: 8,
        maxAutoRepairAttempts: 0,
      },
      context: {
        maxFiles: 4,
        maxChars: 4000,
        recentFileCount: 2,
        exclude: ['.agent/**'],
        sensitive: ['.env*'],
      },
      policy: {
        path: {
          readWrite: ['.'],
          readOnly: [],
          deny: [],
        },
        shell: {
          enabled: true,
          workspaceOnly: true,
          inheritEnv: false,
          allowEnv: ['PATH', 'HOME', 'LANG'],
          denyCommands: ['sudo', 'curl', 'wget'],
          denyPatterns: ['http://', 'https://', 'rm -rf /'],
          timeoutMs: 5000,
          maxBufferBytes: 128 * 1024,
        },
        network: {
          allowExternalToolNetwork: false,
          allowProviderHosts: [],
        },
      },
      verifier: {
        enabled: false,
        timeoutMs: 5000,
        commands: [],
        path: path.join(workspaceRoot, '.marblecode/verifier.md'),
        autoAnalyzeFailures: false,
      },
      session: {
        dir: '.agent/sessions',
        maxSessions: 5,
        maxAgeDays: 1,
        logPromptBodies: false,
        logToolBodies: false,
        redactSecrets: true,
      },
      project: {
        dir: path.join(workspaceRoot, '.marblecode'),
        configPath: null,
        env: {},
      },
    };

    const policy = new PolicyEngine(config);
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools(config, policy)) {
      registry.register(tool);
    }

    const result = await runAgent(config, new Map([[ 'smoke', new SmokeProvider() ]]), registry, {
      prompt: 'Modify the sample file.',
      explicitFiles: ['sample.txt'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    const content = await readFile(path.join(workspaceRoot, 'sample.txt'), 'utf8');
    if (result.status !== 'completed' || content !== 'after\n') {
      throw new Error(`Smoke test failed: status=${result.status} content=${JSON.stringify(content)}`);
    }

    process.stdout.write(`smoke edit ok\nworkspace=${workspaceRoot}\nsession=${result.sessionDir}\n`);
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}

void main();
