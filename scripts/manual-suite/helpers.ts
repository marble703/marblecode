import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../src/config/load.js';
import type { AppConfig } from '../../src/config/schema.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { createAgentToolRegistry, createPlannerToolRegistry } from '../../src/tools/setup.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import type { ToolProvider } from '../../src/tools/types.js';
import type { WorkspaceContext } from './types.js';

const SUITE_ROOT = fileURLToPath(new URL('../../examples/manual-test-suite/project/', import.meta.url));

export async function withWorkspace(
  run: (context: WorkspaceContext) => Promise<void>,
): Promise<void> {
  await withCopiedFixture(SUITE_ROOT, run);
}

export async function withCopiedFixture(
  fixtureRoot: string,
  run: (context: WorkspaceContext) => Promise<void>,
): Promise<void> {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'marblecode-example-suite-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  try {
    await cp(fixtureRoot, workspaceRoot, { recursive: true });
    await writeFile(path.join(tempRoot, 'outside.txt'), 'blocked\n', 'utf8');
    await writeFile(
      path.join(workspaceRoot, 'agent.config.jsonc'),
      JSON.stringify(createAgentConfig(), null, 2),
      'utf8',
    );

    const config = await loadConfig(path.join(workspaceRoot, 'agent.config.jsonc'));
    const policy = new PolicyEngine(config);
    const registry = createAgentToolRegistry(config, policy);
    try {
      await run({ tempRoot, workspaceRoot, config, policy, registry });
    } finally {
      await registry.disposeAll();
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

export function createAgentConfig(): Record<string, unknown> {
  return {
    workspaceRoot: '.',
    providers: {
      stub: {
        type: 'openai-compatible',
        baseUrl: 'https://example.invalid/v1',
        apiKeyEnv: 'STUB_UNUSED',
      },
    },
    models: {
      cheap: { provider: 'stub', model: 'stub-model' },
      code: { provider: 'stub', model: 'stub-model' },
      strong: { provider: 'stub', model: 'stub-model' },
    },
    routing: {
      defaultModel: 'cheap',
      codeModel: 'code',
      planningModel: 'strong',
      maxSteps: 8,
      maxAutoRepairAttempts: 0,
      maxConcurrentSubtasks: 1,
      subtaskMaxAttempts: 2,
      subtaskReplanOnFailure: true,
      subtaskConflictPolicy: 'serial',
    },
    context: {
      maxFiles: 8,
      maxChars: 8000,
      recentFileCount: 2,
      exclude: ['node_modules/**', '.git/**', '.agent/**'],
      sensitive: ['.env*'],
      autoDeny: [],
    },
    tools: {
      externalProvidersEnabled: false,
      allow: [],
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
        denyCommands: ['sudo', 'curl', 'wget', 'ssh', 'scp', 'nc', 'ncat', 'netcat', 'ping'],
        denyPatterns: ['rm -rf /', 'nohup', 'disown', '&', 'http://', 'https://', 'git clone', 'git fetch', 'git pull', 'git push'],
        timeoutMs: 120000,
        maxBufferBytes: 1024 * 1024,
      },
      network: {
        allowExternalToolNetwork: false,
        allowProviderHosts: [],
      },
    },
    session: {
      dir: '.agent/sessions',
      maxSessions: 20,
      maxAgeDays: 1,
      logPromptBodies: false,
      logToolBodies: false,
      redactSecrets: true,
      modelRetryAttempts: 3,
      modelRetryDelayMs: 1,
    },
  };
}

export function createPlannerRegistry(config: AppConfig, policy: PolicyEngine): ToolRegistry {
  return createPlannerToolRegistry(config, policy);
}

export function createPlannerRegistryWithProviders(
  config: AppConfig,
  policy: PolicyEngine,
  providers: ToolProvider[],
): ToolRegistry {
  return createPlannerToolRegistry(config, policy, providers);
}

export async function buildMathFixStep(workspaceRoot: string): Promise<string> {
  const current = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
  const next = current.replace('return a - b;', 'return a + b;');
  return JSON.stringify({
    type: 'patch',
    thought: 'Fix the add implementation in the fixture project.',
    patch: {
      version: '1',
      summary: 'Fix the add function in the manual suite fixture.',
      operations: [
        {
          type: 'replace_file',
          path: 'src/math.js',
          diff: 'Replace subtraction with addition in add().',
          oldText: current,
          newText: next,
        },
      ],
    },
  });
}

export async function buildMultiFileFixStep(workspaceRoot: string): Promise<string> {
  const currentMath = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
  const nextMath = currentMath.replace('return a - b;', 'return a + b;');
  const currentNotes = await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8');
  const nextNotes = `${currentNotes}\nFIXED_NOTE: add now returns a + b\n`;
  return JSON.stringify({
    type: 'patch',
    thought: 'Update both code and nearby documentation in one patch.',
    patch: {
      version: '1',
      summary: 'Fix the add function and update notes in the manual suite fixture.',
      operations: [
        {
          type: 'replace_file',
          path: 'src/math.js',
          diff: 'Replace subtraction with addition in add().',
          oldText: currentMath,
          newText: nextMath,
        },
        {
          type: 'replace_file',
          path: 'src/notes.txt',
          diff: 'Append a note confirming the bug fix.',
          oldText: currentNotes,
          newText: nextNotes,
        },
      ],
    },
  });
}

export async function buildNotesOnlyStep(workspaceRoot: string): Promise<string> {
  const currentNotes = await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8');
  const nextNotes = `${currentNotes}\nFIXED_NOTE: notes updated in a concurrent wave\n`;
  return JSON.stringify({
    type: 'patch',
    thought: 'Update fixture notes only.',
    patch: {
      version: '1',
      summary: 'Update the notes file in the manual suite fixture.',
      operations: [
        {
          type: 'replace_file',
          path: 'src/notes.txt',
          diff: 'Append a note confirming the wave execution update.',
          oldText: currentNotes,
          newText: nextNotes,
        },
      ],
    },
  });
}
