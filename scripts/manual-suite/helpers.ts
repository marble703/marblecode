import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

export function enableExternalProvider(config: AppConfig, providerId: string): void {
  config.tools.externalProvidersEnabled = true;
  config.tools.allow = [providerId];
}

export async function writeMarbleArtifact(
  workspaceRoot: string,
  fileName: string,
  payload: unknown,
): Promise<void> {
  await writeFile(
    path.join(workspaceRoot, '.marblecode', fileName),
    JSON.stringify(payload, null, 2),
    'utf8',
  );
}

export async function readJsonl<T>(filePath: string): Promise<T[]> {
  const content = await readFile(filePath, 'utf8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as T);
}

export function assertJsonlRecord<T>(
  records: T[],
  predicate: (record: T) => boolean,
  message: string,
): T {
  const match = records.find(predicate);
  assert.ok(match, message);
  return match as T;
}

export async function readSessionJsonl<T>(sessionDir: string, fileName: string): Promise<T[]> {
  return readJsonl<T>(path.join(sessionDir, fileName));
}

export async function assertToolLogEntry(
  sessionDir: string,
  toolName: string,
  predicate: (record: Record<string, unknown>) => boolean,
  message: string,
): Promise<Record<string, unknown>> {
  const records = await readSessionJsonl<Record<string, unknown>>(sessionDir, 'tools.jsonl');
  return assertJsonlRecord(
    records,
    (record) => record.tool === toolName && predicate(record),
    message,
  );
}

export async function assertPlannerEvent(
  sessionDir: string,
  eventType: string,
  predicate: (record: Record<string, unknown>) => boolean = () => true,
  message = `Expected planner event ${eventType}`,
): Promise<Record<string, unknown>> {
  const records = await readSessionJsonl<Record<string, unknown>>(sessionDir, 'plan.events.jsonl');
  return assertJsonlRecord(
    records,
    (record) => record.type === eventType && predicate(record),
    message,
  );
}

export async function assertSessionJsonlRecord(
  sessionDir: string,
  fileName: string,
  predicate: (record: Record<string, unknown>) => boolean,
  message: string,
): Promise<Record<string, unknown>> {
  const records = await readSessionJsonl<Record<string, unknown>>(sessionDir, fileName);
  return assertJsonlRecord(records, predicate, message);
}

export async function assertPlannerLogEntry(
  sessionDir: string,
  logType: string,
  predicate: (record: Record<string, unknown>) => boolean = () => true,
  message = `Expected planner log entry ${logType}`,
): Promise<Record<string, unknown>> {
  return assertSessionJsonlRecord(
    sessionDir,
    'planner.log.jsonl',
    (record) => record.type === logType && predicate(record),
    message,
  );
}

type PlannerJsonRecord = Record<string, unknown>;

export function createPlannerPlan<TStep extends PlannerJsonRecord = PlannerJsonRecord>(
  overrides: Partial<{
    version: '1';
    revision: number;
    summary: string;
    isPartial: boolean;
    planningHorizon: { waveCount?: number };
    steps: TStep[];
  }> = {},
): {
  version: '1';
  revision: number;
  summary: string;
  steps: TStep[];
  isPartial?: boolean;
  planningHorizon?: { waveCount?: number };
} {
  return {
    version: '1',
    revision: 1,
    summary: 'Planner test fixture.',
    steps: [],
    ...(overrides.summary ? { summary: overrides.summary } : {}),
    ...(typeof overrides.revision === 'number' ? { revision: overrides.revision } : {}),
    ...(Array.isArray(overrides.steps) ? { steps: overrides.steps } : {}),
    ...(overrides.isPartial === true ? { isPartial: true } : {}),
    ...(overrides.planningHorizon ? { planningHorizon: overrides.planningHorizon } : {}),
  };
}

export function createPlannerState(
  overrides: Partial<{
    version: '1';
    revision: number;
    phase: string;
    outcome: string;
    currentStepId: string | null;
    activeStepIds: string[];
    readyStepIds: string[];
    completedStepIds: string[];
    failedStepIds: string[];
    blockedStepIds: string[];
    invalidResponseAttempts: number;
    message: string;
    consistencyErrors: string[];
  }> = {},
): PlannerJsonRecord {
  return {
    version: '1',
    revision: 1,
    phase: 'PENDING',
    outcome: 'RUNNING',
    currentStepId: null,
    activeStepIds: [],
    readyStepIds: [],
    completedStepIds: [],
    failedStepIds: [],
    blockedStepIds: [],
    invalidResponseAttempts: 0,
    message: 'Planner test fixture.',
    consistencyErrors: [],
    ...overrides,
  };
}

export function createExecutionState(
  overrides: Partial<{
    version: '1';
    revision: number;
    executionPhase: string;
    plannerPhase: string;
    outcome: string;
    activeStepIds: string[];
    readyStepIds: string[];
    completedStepIds: string[];
    failedStepIds: string[];
    blockedStepIds: string[];
    degradedStepIds: string[];
    currentWaveStepIds: string[];
    lastCompletedWaveStepIds: string[];
    selectedWaveStepIds: string[];
    interruptedStepIds: string[];
    resumeStrategy: string;
    lastEventType: string;
    lastEventReason: string;
    strategy: string;
    epoch: number;
    currentStepId: string | null;
    message: string;
    planningWindowState: string;
    recoverySourceStepId: string | null;
    recoveryStepId: string | null;
    recoverySubgraphStepIds: string[];
    lockResumeMode: string;
    recoveryReason: string;
    reusedLockOwnerStepIds: string[];
    preservedLockOwnerStepIds: string[];
    downgradedLockOwnerStepIds: string[];
    droppedLockOwnerStepIds: string[];
  }> = {},
): PlannerJsonRecord {
  return {
    version: '1',
    revision: 1,
    executionPhase: 'idle',
    plannerPhase: 'PENDING',
    outcome: 'RUNNING',
    activeStepIds: [],
    readyStepIds: [],
    completedStepIds: [],
    failedStepIds: [],
    blockedStepIds: [],
    degradedStepIds: [],
    currentWaveStepIds: [],
    lastCompletedWaveStepIds: [],
    selectedWaveStepIds: [],
    interruptedStepIds: [],
    resumeStrategy: 'rebuild_from_plan',
    lastEventType: '',
    lastEventReason: '',
    strategy: 'serial',
    epoch: 0,
    currentStepId: null,
    message: 'Planner execution test fixture.',
    planningWindowState: '',
    recoverySourceStepId: null,
    recoveryStepId: null,
    recoverySubgraphStepIds: [],
    lockResumeMode: '',
    recoveryReason: '',
    reusedLockOwnerStepIds: [],
    preservedLockOwnerStepIds: [],
    downgradedLockOwnerStepIds: [],
    droppedLockOwnerStepIds: [],
    ...overrides,
  };
}

export function createExecutionLocks(
  entries: Array<{ path: string; mode: string; ownerStepId: string; revision?: number }>,
  overrides: Partial<{ version: '1'; revision: number }> = {},
): {
  version: '1';
  revision: number;
  entries: Array<{ path: string; mode: string; ownerStepId: string; revision: number }>;
} {
  return {
    version: '1',
    revision: 1,
    ...(typeof overrides.revision === 'number' ? { revision: overrides.revision } : {}),
    entries: entries.map((entry) => ({
      ...entry,
      revision: typeof entry.revision === 'number' ? entry.revision : 1,
    })),
  };
}

export async function writePlannerArtifacts(
  sessionDir: string,
  artifacts: Partial<{
    plannerRequest: unknown;
    plannerContext: unknown;
    plannerContextPacket: unknown;
    plan: unknown;
    planState: unknown;
    executionGraph: unknown;
    executionLocks: unknown;
    executionState: unknown;
  }>,
): Promise<void> {
  await mkdir(path.dirname(sessionDir), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  if (artifacts.plannerRequest !== undefined) {
    await writeFile(path.join(sessionDir, 'planner.request.json'), JSON.stringify(artifacts.plannerRequest, null, 2), 'utf8');
  }
  if (artifacts.plannerContext !== undefined) {
    await writeFile(path.join(sessionDir, 'planner.context.json'), JSON.stringify(artifacts.plannerContext, null, 2), 'utf8');
  }
  if (artifacts.plannerContextPacket !== undefined) {
    await writeFile(path.join(sessionDir, 'planner.context.packet.json'), JSON.stringify(artifacts.plannerContextPacket, null, 2), 'utf8');
  }
  if (artifacts.plan !== undefined) {
    await writeFile(path.join(sessionDir, 'plan.json'), JSON.stringify(artifacts.plan, null, 2), 'utf8');
  }
  if (artifacts.planState !== undefined) {
    await writeFile(path.join(sessionDir, 'plan.state.json'), JSON.stringify(artifacts.planState, null, 2), 'utf8');
  }
  if (artifacts.executionGraph !== undefined) {
    await writeFile(path.join(sessionDir, 'execution.graph.json'), JSON.stringify(artifacts.executionGraph, null, 2), 'utf8');
  }
  if (artifacts.executionLocks !== undefined) {
    await writeFile(path.join(sessionDir, 'execution.locks.json'), JSON.stringify(artifacts.executionLocks, null, 2), 'utf8');
  }
  if (artifacts.executionState !== undefined) {
    await writeFile(path.join(sessionDir, 'execution.state.json'), JSON.stringify(artifacts.executionState, null, 2), 'utf8');
  }
}

export async function writePlannerEvents(sessionDir: string, events: unknown[]): Promise<void> {
  await mkdir(path.dirname(sessionDir), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  const content = events.map((event) => JSON.stringify(event)).join('\n');
  await writeFile(path.join(sessionDir, 'plan.events.jsonl'), content.length > 0 ? `${content}\n` : '', 'utf8');
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
