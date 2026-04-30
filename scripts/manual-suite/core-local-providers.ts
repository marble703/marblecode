import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runAgent } from '../../src/agent/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { createLocalDiagnosticsProvider } from '../../src/tools/local-diagnostics-provider.js';
import { normalizeWorkspacePath, readLocalArtifact } from '../../src/tools/local-artifacts.js';
import { createLocalReferencesProvider } from '../../src/tools/local-references-provider.js';
import { createLocalSymbolsProvider } from '../../src/tools/local-symbols-provider.js';
import { createAgentToolRegistry } from '../../src/tools/setup.js';
import type { ModelProvider } from '../../src/provider/types.js';
import {
  assertJsonlRecord,
  assertToolLogEntry,
  createExecutionLocks,
  createExecutionState,
  createPlannerPlan,
  createPlannerState,
  enableExternalProvider,
  readJsonl,
  withWorkspace,
  writeMarbleArtifact,
  writePlannerArtifacts,
  writePlannerEvents,
} from './helpers.js';
import { SequenceProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createCoreLocalProviderCases(): ManualSuiteCase[] {
  return [
    { name: 'local artifact helper returns missing', run: testLocalArtifactHelperReturnsMissing },
    { name: 'local artifact helper rejects workspace escape', run: testLocalArtifactHelperRejectsWorkspaceEscape },
    { name: 'jsonl helper reads records', run: testJsonlHelperReadsRecords },
    { name: 'jsonl helper asserts matching record', run: testJsonlHelperAssertsMatchingRecord },
    { name: 'planner artifact fixture helpers write expected files', run: testPlannerArtifactFixtureHelpersWriteExpectedFiles },
    { name: 'local diagnostics provider reads artifact', run: testLocalDiagnosticsProviderReadsArtifact },
    { name: 'local diagnostics provider filters path and severity', run: testLocalDiagnosticsProviderFiltersPathAndSeverity },
    { name: 'local diagnostics provider returns empty when missing', run: testLocalDiagnosticsProviderReturnsEmptyWhenMissing },
    { name: 'local diagnostics provider rejects workspace escape', run: testLocalDiagnosticsProviderRejectsWorkspaceEscape },
    { name: 'local symbols provider reads artifact', run: testLocalSymbolsProviderReadsArtifact },
    { name: 'local symbols provider filters path name and kind', run: testLocalSymbolsProviderFiltersPathNameAndKind },
    { name: 'local symbols provider returns empty when missing', run: testLocalSymbolsProviderReturnsEmptyWhenMissing },
    { name: 'local symbols provider rejects invalid format', run: testLocalSymbolsProviderRejectsInvalidFormat },
    { name: 'local symbols provider rejects workspace escape', run: testLocalSymbolsProviderRejectsWorkspaceEscape },
    { name: 'tool log sanitizes local symbols source', run: testToolLogSanitizesLocalSymbolsSource },
    { name: 'local references provider reads artifact', run: testLocalReferencesProviderReadsArtifact },
    { name: 'local references provider filters path symbol and kind', run: testLocalReferencesProviderFiltersPathSymbolAndKind },
    { name: 'local references provider returns empty when missing', run: testLocalReferencesProviderReturnsEmptyWhenMissing },
    { name: 'local references provider rejects invalid format', run: testLocalReferencesProviderRejectsInvalidFormat },
    { name: 'local references provider rejects workspace escape', run: testLocalReferencesProviderRejectsWorkspaceEscape },
    { name: 'local references provider rejects target workspace escape', run: testLocalReferencesProviderRejectsTargetWorkspaceEscape },
    { name: 'tool log sanitizes local references source', run: testToolLogSanitizesLocalReferencesSource },
  ];
}

async function testLocalArtifactHelperReturnsMissing(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const result = await readLocalArtifact<{ version: '1' }>(config, policy, 'missing-artifact.json');
    assert.deepEqual(result, { status: 'missing' });
  });
}

async function testLocalArtifactHelperRejectsWorkspaceEscape(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const result = normalizeWorkspacePath(config, policy, '../outside.txt', 'Local artifact path escapes workspace');
    assert.equal(result.status, 'error');
    assert.match(result.error ?? '', /Local artifact path escapes workspace/);
  });
}

async function testJsonlHelperReadsRecords(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const jsonlPath = path.join(workspaceRoot, 'records.jsonl');
    await writeFile(
      jsonlPath,
      `${JSON.stringify({ type: 'one', value: 1 })}\n${JSON.stringify({ type: 'two', value: 2 })}\n`,
      'utf8',
    );
    const records = await readJsonl<{ type: string; value: number }>(jsonlPath);
    assert.deepEqual(records, [
      { type: 'one', value: 1 },
      { type: 'two', value: 2 },
    ]);
  });
}

async function testJsonlHelperAssertsMatchingRecord(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const jsonlPath = path.join(workspaceRoot, 'records.jsonl');
    await writeFile(
      jsonlPath,
      `${JSON.stringify({ type: 'one', value: 1 })}\n${JSON.stringify({ type: 'two', value: 2 })}\n`,
      'utf8',
    );
    const records = await readJsonl<{ type: string; value: number }>(jsonlPath);
    const record = assertJsonlRecord(records, (entry) => entry.type === 'two', 'Expected type two');
    assert.deepEqual(record, { type: 'two', value: 2 });
  });
}

async function testPlannerArtifactFixtureHelpersWriteExpectedFiles(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    const sessionDir = path.join(workspaceRoot, 'fixture-session');
    const plan = createPlannerPlan({
      summary: 'Fixture helper plan.',
      steps: [{ id: 'step-1', title: 'Inspect math', status: 'PENDING', kind: 'search', children: [] }],
    });
    await writePlannerArtifacts(sessionDir, {
      plannerRequest: { promptHistory: ['inspect math'] },
      plan,
      planState: createPlannerState({ phase: 'PLANNING', currentStepId: 'step-1', message: 'Planning fixture.' }),
      executionState: createExecutionState({ executionPhase: 'executing_wave', currentWaveStepIds: ['step-1'], currentStepId: 'step-1' }),
      executionLocks: createExecutionLocks([{ path: 'src/math.js', mode: 'guarded_read', ownerStepId: 'step-1' }]),
    });
    await writePlannerEvents(sessionDir, [{ type: 'planner_started', revision: 1 }]);

    const storedPlan = JSON.parse(await readFile(path.join(sessionDir, 'plan.json'), 'utf8')) as { summary: string; steps: Array<{ id: string }> };
    const storedState = JSON.parse(await readFile(path.join(sessionDir, 'plan.state.json'), 'utf8')) as { phase: string; currentStepId: string | null };
    const storedExecution = JSON.parse(await readFile(path.join(sessionDir, 'execution.state.json'), 'utf8')) as { executionPhase: string; currentWaveStepIds: string[] };
    const storedLocks = JSON.parse(await readFile(path.join(sessionDir, 'execution.locks.json'), 'utf8')) as { entries: Array<{ ownerStepId: string }> };
    const storedEvents = await readJsonl<{ type: string }>(path.join(sessionDir, 'plan.events.jsonl'));

    assert.equal(storedPlan.summary, 'Fixture helper plan.');
    assert.equal(storedPlan.steps[0]?.id, 'step-1');
    assert.equal(storedState.phase, 'PLANNING');
    assert.equal(storedState.currentStepId, 'step-1');
    assert.equal(storedExecution.executionPhase, 'executing_wave');
    assert.deepEqual(storedExecution.currentWaveStepIds, ['step-1']);
    assert.equal(storedLocks.entries[0]?.ownerStepId, 'step-1');
    assert.deepEqual(storedEvents, [{ type: 'planner_started', revision: 1 }]);
  });
}

async function testLocalDiagnosticsProviderReadsArtifact(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-diagnostics');
    await writeMarbleArtifact(workspaceRoot, 'diagnostics.json', {
      version: '1',
      diagnostics: [{
        path: 'src/math.js',
        severity: 'warning',
        message: 'Possible arithmetic mismatch.',
        line: 2,
        column: 10,
        source: 'local-diagnostics',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalDiagnosticsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'diagnostics_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/math.js',
        severity: 'warning',
        message: 'Possible arithmetic mismatch.',
        line: 2,
        column: 10,
        source: 'local-diagnostics',
      }]);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalDiagnosticsProviderFiltersPathAndSeverity(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-diagnostics');
    await writeMarbleArtifact(workspaceRoot, 'diagnostics.json', {
      version: '1',
      diagnostics: [
        {
          path: 'src/math.js',
          severity: 'warning',
          message: 'Possible arithmetic mismatch.',
          line: 2,
          column: 10,
          source: 'local-diagnostics',
        },
        {
          path: 'src/router.js',
          severity: 'info',
          message: 'Route order note.',
          line: 5,
          column: 1,
          source: 'local-diagnostics',
        },
      ],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalDiagnosticsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'diagnostics_list', input: { path: 'src/math.js', severity: 'warning' } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/math.js',
        severity: 'warning',
        message: 'Possible arithmetic mismatch.',
        line: 2,
        column: 10,
        source: 'local-diagnostics',
      }]);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalDiagnosticsProviderReturnsEmptyWhenMissing(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    enableExternalProvider(config, 'local-diagnostics');
    const registry = createAgentToolRegistry(config, policy, [createLocalDiagnosticsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'diagnostics_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, []);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalDiagnosticsProviderRejectsWorkspaceEscape(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-diagnostics');
    await writeMarbleArtifact(workspaceRoot, 'diagnostics.json', {
      version: '1',
      diagnostics: [{
        path: '../outside.txt',
        severity: 'error',
        message: 'Outside workspace.',
        line: 1,
        column: 1,
        source: 'local-diagnostics',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalDiagnosticsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'diagnostics_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /escapes workspace/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalSymbolsProviderReadsArtifact(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-symbols');
    await writeMarbleArtifact(workspaceRoot, 'symbols.json', {
      version: '1',
      symbols: [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'local-symbols',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'symbols_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'local-symbols',
      }]);
      assert.deepEqual(registry.getProviderForTool('symbols_list')?.metadata?.capabilities ?? [], ['symbols']);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalSymbolsProviderFiltersPathNameAndKind(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-symbols');
    await writeMarbleArtifact(workspaceRoot, 'symbols.json', {
      version: '1',
      symbols: [
        {
          path: 'src/math.js',
          name: 'multiply',
          kind: 'function',
          line: 5,
          column: 1,
          source: 'local-symbols',
        },
        {
          path: 'src/router.js',
          name: 'Router',
          kind: 'class',
          line: 1,
          column: 1,
          source: 'local-symbols',
        },
      ],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'symbols_list', input: { path: 'src/math.js', name: 'multiply', kind: 'function' } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'local-symbols',
      }]);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalSymbolsProviderReturnsEmptyWhenMissing(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    enableExternalProvider(config, 'local-symbols');
    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'symbols_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, []);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalSymbolsProviderRejectsInvalidFormat(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-symbols');
    await writeMarbleArtifact(workspaceRoot, 'symbols.json', {
      version: '2',
      symbols: [],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'symbols_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Invalid local symbols artifact format/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalSymbolsProviderRejectsWorkspaceEscape(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-symbols');
    await writeMarbleArtifact(workspaceRoot, 'symbols.json', {
      version: '1',
      symbols: [{
        path: '../outside.txt',
        name: 'steal',
        kind: 'function',
        line: 1,
        column: 1,
        source: 'local-symbols',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'symbols_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /escapes workspace/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testToolLogSanitizesLocalSymbolsSource(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.session.logToolBodies = true;
    enableExternalProvider(config, 'local-symbols');
    await writeMarbleArtifact(workspaceRoot, 'symbols.json', {
      version: '1',
      symbols: [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'workspace-symbol-index',
      }],
    });

    const policy = new PolicyEngine(config);
    const registry = createAgentToolRegistry(config, policy, [createLocalSymbolsProvider(config, policy)]);
    const providers = new Map<string, ModelProvider>([['stub', new SequenceProvider([
      JSON.stringify({
        type: 'tool_call',
        tool: 'symbols_list',
        input: { path: 'src/math.js' },
      }),
      JSON.stringify({
        type: 'final',
        message: 'Symbols loaded.',
      }),
    ])]]);

    try {
      const result = await runAgent(config, providers, registry, {
        prompt: 'Load symbols only',
        explicitFiles: ['src/math.js'],
        pastedSnippets: [],
        manualVerifierCommands: [],
        autoApprove: true,
        confirm: async () => true,
      });
      assert.equal(result.status, 'completed');
      const logEntry = await assertToolLogEntry(
        result.sessionDir,
        'symbols_list',
        (record) => record.providerId === 'local-symbols',
        'Expected symbols tool log entry',
      );
      assert.equal(logEntry.providerKind, 'external');
      assert.equal(logEntry.providerAccess, 'read_only');
      assert.deepEqual(logEntry.providerCapabilities, ['symbols']);
      assert.equal(logEntry.symbolsSource, '[local-symbols]');
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderReadsArtifact(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '1',
      references: [{
        path: 'src/router.js',
        symbolName: 'registerRoute',
        line: 8,
        column: 3,
        kind: 'reference',
        targetPath: 'src/register-routes.js',
        targetLine: 2,
        targetColumn: 1,
        source: 'local-references',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'references_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/router.js',
        symbolName: 'registerRoute',
        line: 8,
        column: 3,
        kind: 'reference',
        targetPath: 'src/register-routes.js',
        targetLine: 2,
        targetColumn: 1,
        source: 'local-references',
      }]);
      assert.deepEqual(registry.getProviderForTool('references_list')?.metadata?.capabilities ?? [], ['references']);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderFiltersPathSymbolAndKind(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '1',
      references: [
        {
          path: 'src/router.js',
          symbolName: 'registerRoute',
          line: 8,
          column: 3,
          kind: 'reference',
          targetPath: 'src/register-routes.js',
          targetLine: 2,
          targetColumn: 1,
          source: 'local-references',
        },
        {
          path: 'src/server.js',
          symbolName: 'startServer',
          line: 4,
          column: 1,
          kind: 'definition',
          source: 'local-references',
        },
      ],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({
        name: 'references_list',
        input: { path: 'src/router.js', symbolName: 'registerRoute', kind: 'reference' },
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/router.js',
        symbolName: 'registerRoute',
        line: 8,
        column: 3,
        kind: 'reference',
        targetPath: 'src/register-routes.js',
        targetLine: 2,
        targetColumn: 1,
        source: 'local-references',
      }]);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderReturnsEmptyWhenMissing(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    enableExternalProvider(config, 'local-references');
    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'references_list', input: {} });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, []);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderRejectsInvalidFormat(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '2',
      references: [],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'references_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Invalid local references artifact format/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderRejectsWorkspaceEscape(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '1',
      references: [{
        path: '../outside.txt',
        symbolName: 'registerRoute',
        line: 1,
        column: 1,
        kind: 'reference',
        source: 'local-references',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'references_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Local references path escapes workspace/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderRejectsTargetWorkspaceEscape(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '1',
      references: [{
        path: 'src/router.js',
        symbolName: 'registerRoute',
        line: 8,
        column: 3,
        kind: 'reference',
        targetPath: '../outside.txt',
        targetLine: 1,
        targetColumn: 1,
        source: 'local-references',
      }],
    });

    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    try {
      const result = await registry.execute({ name: 'references_list', input: {} });
      assert.equal(result.ok, false);
      assert.match(result.error ?? '', /Local references target path escapes workspace/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testToolLogSanitizesLocalReferencesSource(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    config.session.logToolBodies = true;
    enableExternalProvider(config, 'local-references');
    await writeMarbleArtifact(workspaceRoot, 'references.json', {
      version: '1',
      references: [{
        path: 'src/router.js',
        symbolName: 'registerRoute',
        line: 8,
        column: 3,
        kind: 'reference',
        targetPath: 'src/register-routes.js',
        targetLine: 2,
        targetColumn: 1,
        source: 'workspace-reference-index',
      }],
    });

    const policy = new PolicyEngine(config);
    const registry = createAgentToolRegistry(config, policy, [createLocalReferencesProvider(config, policy)]);
    const providers = new Map<string, ModelProvider>([['stub', new SequenceProvider([
      JSON.stringify({
        type: 'tool_call',
        tool: 'references_list',
        input: { path: 'src/router.js' },
      }),
      JSON.stringify({
        type: 'final',
        message: 'References loaded.',
      }),
    ])]]);

    try {
      const result = await runAgent(config, providers, registry, {
        prompt: 'Load references only',
        explicitFiles: ['src/router.js'],
        pastedSnippets: [],
        manualVerifierCommands: [],
        autoApprove: true,
        confirm: async () => true,
      });
      assert.equal(result.status, 'completed');
      const logEntry = await assertToolLogEntry(
        result.sessionDir,
        'references_list',
        (record) => record.providerId === 'local-references',
        'Expected references tool log entry',
      );
      assert.equal(logEntry.providerKind, 'external');
      assert.equal(logEntry.providerAccess, 'read_only');
      assert.deepEqual(logEntry.providerCapabilities, ['references']);
      assert.equal(logEntry.referencesSource, '[local-references]');
    } finally {
      await registry.disposeAll();
    }
  });
}
