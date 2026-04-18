import { fileURLToPath } from 'node:url';
import { PolicyEngine } from '../src/policy/index.js';
import type { AppConfig } from '../src/config/schema.js';
import { runVerifier } from '../src/verifier/index.js';

async function main(): Promise<void> {
  const workspaceRoot = fileURLToPath(new URL('../examples/verifier-fixture/', import.meta.url));
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
      exclude: ['dist/**'],
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
        allowEnv: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM'],
        denyCommands: ['sudo', 'curl', 'wget'],
        denyPatterns: ['rm -rf /', 'http://', 'https://'],
        timeoutMs: 120000,
        maxBufferBytes: 1024 * 1024,
      },
      network: {
        allowExternalToolNetwork: false,
        allowProviderHosts: [],
      },
    },
    verifier: {
      enabled: true,
      timeoutMs: 120000,
      commands: [],
      path: fileURLToPath(new URL('../examples/verifier-fixture/.marblecode/verifier.md', import.meta.url)),
      autoAnalyzeFailures: false,
      allowDiscovery: true,
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
      dir: fileURLToPath(new URL('../examples/verifier-fixture/.marblecode/', import.meta.url)),
      configPath: null,
      env: {},
    },
  };

  const result = await runVerifier(config, new PolicyEngine(config), {
    changedFiles: ['src/index.ts'],
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

  if (!result.success) {
    process.exitCode = 1;
  }
}

void main();
