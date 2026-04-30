import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { runAgent } from '../../src/agent/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { createDiagnosticsFixtureProvider, createExternalDiagnosticsFixtureProvider } from '../../src/tools/diagnostics-provider.js';
import { buildToolLogRecord } from '../../src/tools/logging.js';
import { StaticToolProvider } from '../../src/tools/provider.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createAgentToolRegistry } from '../../src/tools/setup.js';
import { createBuiltinToolProvider, createPlannerToolProvider } from '../../src/tools/builtins.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { assertToolLogEntry, withWorkspace } from './helpers.js';
import { SequenceProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createCoreProviderCases(): ManualSuiteCase[] {
  return [
    { name: 'tool provider registry', run: testToolProviderRegistry },
    { name: 'tool provider lifecycle', run: testToolProviderLifecycle },
    { name: 'tool provider duplicate id', run: testToolProviderDuplicateId },
    { name: 'readonly diagnostics provider', run: testReadonlyDiagnosticsProvider },
    { name: 'external readonly provider gate blocks by default', run: testExternalReadonlyProviderGateBlocksByDefault },
    { name: 'external readonly provider gate allows allowlisted provider', run: testExternalReadonlyProviderGateAllowsAllowlistedProvider },
    { name: 'tool provider dispose failure reports provider id', run: testToolProviderDisposeFailureReportsProviderId },
    { name: 'tool provider summary helper', run: testToolProviderSummaryHelper },
    { name: 'external readonly provider gate reports access reason', run: testExternalReadonlyProviderGateReportsAccessReason },
    { name: 'tool provider dispose summary', run: testToolProviderDisposeSummary },
    { name: 'tool log includes provider metadata', run: testToolLogIncludesProviderMetadata },
    { name: 'tool log helper includes provider metadata', run: testToolLogHelperIncludesProviderMetadata },
    { name: 'tool log helper includes capability source fields', run: testToolLogHelperIncludesCapabilitySourceFields },
  ];
}

async function testToolProviderRegistry(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = new ToolRegistry();
    registry.registerProvider(createBuiltinToolProvider(config, policy));

    const providers = registry.listProviders();
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, 'builtin');
    assert.equal(providers[0]?.metadata?.access, 'read_write');

    const definitions = registry.listDefinitions().map((definition) => definition.name);
    assert.ok(definitions.includes('read_file'));
    assert.ok(definitions.includes('git_diff'));

    const read = await registry.execute({ name: 'read_file', input: { path: 'src/math.js' } });
    assert.equal(read.ok, true);

    const blocked = await registry.execute({ name: 'run_shell', input: { command: 'curl https://example.com' } });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error ?? '', /blocked by policy|matched blocked pattern/);

    const plannerRegistry = new ToolRegistry();
    plannerRegistry.registerProvider(createPlannerToolProvider(config, policy));
    const plannerDefinitions = plannerRegistry.listDefinitions().map((definition) => definition.name);
    assert.ok(plannerDefinitions.includes('read_file'));
    assert.ok(plannerDefinitions.includes('git_diff'));
    assert.equal(plannerDefinitions.includes('run_shell'), false);
    assert.equal(plannerRegistry.getProviderForTool('read_file')?.metadata?.access, 'read_only');

    const duplicateRegistry = new ToolRegistry();
    duplicateRegistry.registerProvider(new StaticToolProvider('provider-a', [{
      definition: {
        name: 'dup_tool',
        description: 'duplicate tool a',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { ok: true };
      },
    }]));
    assert.throws(() => duplicateRegistry.registerProvider(new StaticToolProvider('provider-b', [{
      definition: {
        name: 'dup_tool',
        description: 'duplicate tool b',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { ok: true };
      },
    }])), /Duplicate tool registration: dup_tool/);
  });
}

async function testToolProviderLifecycle(): Promise<void> {
  await withWorkspace(async () => {
    let disposeCount = 0;
    const registry = new ToolRegistry();
    registry.registerProvider({
      id: 'lifecycle-fixture',
      metadata: {
        kind: 'fixture',
        access: 'read_only',
        capabilities: ['diagnostics'],
      },
      listTools() {
        return [{
          definition: {
            name: 'fixture_ping',
            description: 'Ping fixture provider.',
            inputSchema: { type: 'object', properties: {} },
          },
          async execute() {
            return { ok: true, data: 'pong' };
          },
        }];
      },
      async executeTool() {
        return { ok: true, data: 'pong' };
      },
      async dispose() {
        disposeCount += 1;
      },
    });

    const result = await registry.execute({ name: 'fixture_ping', input: {} });
    assert.equal(result.ok, true);
    assert.equal(result.data, 'pong');
    assert.equal(registry.getProviderForTool('fixture_ping')?.id, 'lifecycle-fixture');
    await registry.disposeAll();
    assert.equal(disposeCount, 1);
  });
}

async function testToolProviderDuplicateId(): Promise<void> {
  await withWorkspace(async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(new StaticToolProvider('duplicate-provider', [{
      definition: {
        name: 'dup_one',
        description: 'duplicate provider one',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { ok: true };
      },
    }]));

    assert.throws(() => registry.registerProvider(new StaticToolProvider('duplicate-provider', [{
      definition: {
        name: 'dup_two',
        description: 'duplicate provider two',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { ok: true };
      },
    }])), /Duplicate tool provider registration: duplicate-provider/);
  });
}

async function testReadonlyDiagnosticsProvider(): Promise<void> {
  await withWorkspace(async () => {
    const registry = new ToolRegistry();
    registry.registerProvider(createDiagnosticsFixtureProvider([
      {
        path: 'src/math.js',
        severity: 'warning',
        message: 'Possible arithmetic mismatch.',
        line: 2,
        column: 10,
      },
      {
        path: 'src/router.js',
        severity: 'info',
        message: 'Route ordering check.',
        line: 5,
        column: 1,
      },
    ]));

    const provider = registry.getProviderForTool('diagnostics_list');
    assert.equal(provider?.metadata?.kind, 'fixture');
    assert.equal(provider?.metadata?.access, 'read_only');
    assert.deepEqual(provider?.metadata?.capabilities ?? [], ['diagnostics']);

    const allDiagnostics = await registry.execute({ name: 'diagnostics_list', input: {} });
    assert.equal(allDiagnostics.ok, true);
    assert.equal(Array.isArray(allDiagnostics.data), true);
    assert.equal((allDiagnostics.data as Array<unknown>).length, 2);

    const filteredDiagnostics = await registry.execute({ name: 'diagnostics_list', input: { path: 'src/math.js' } });
    assert.equal(filteredDiagnostics.ok, true);
    assert.deepEqual(filteredDiagnostics.data, [{
      path: 'src/math.js',
      severity: 'warning',
      message: 'Possible arithmetic mismatch.',
      line: 2,
      column: 10,
    }]);
  });
}

async function testExternalReadonlyProviderGateBlocksByDefault(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const externalProvider = createExternalDiagnosticsFixtureProvider([
      {
        path: 'src/math.js',
        severity: 'warning',
        message: 'External provider check.',
        line: 2,
        column: 1,
      },
    ]);
    assert.throws(
      () => createAgentToolRegistry(config, policy, [externalProvider]),
      /disabled by config\.tools\.externalProvidersEnabled/,
    );
  });
}

async function testExternalReadonlyProviderGateAllowsAllowlistedProvider(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['diagnostics-external-fixture'];
    const externalProvider = createExternalDiagnosticsFixtureProvider([
      {
        path: 'src/math.js',
        severity: 'warning',
        message: 'External provider check.',
        line: 2,
        column: 1,
      },
    ]);
    const registry = createAgentToolRegistry(config, policy, [externalProvider]);
    try {
      const result = await registry.execute({ name: 'diagnostics_list', input: { path: 'src/math.js' } });
      assert.equal(result.ok, true);
      assert.deepEqual(result.data, [{
        path: 'src/math.js',
        severity: 'warning',
        message: 'External provider check.',
        line: 2,
        column: 1,
      }]);
      assert.equal(registry.getProviderForTool('diagnostics_list')?.metadata?.kind, 'external');
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testToolProviderDisposeFailureReportsProviderId(): Promise<void> {
  await withWorkspace(async () => {
    const registry = new ToolRegistry();
    registry.registerProvider({
      id: 'dispose-failure-fixture',
      metadata: {
        kind: 'fixture',
        access: 'read_only',
      },
      listTools() {
        return [];
      },
      async executeTool() {
        return { ok: false, error: 'unused' };
      },
      async dispose() {
        throw new Error('dispose failed');
      },
    });

    await assert.rejects(
      () => registry.disposeAll(),
      /dispose-failure-fixture: dispose failed/,
    );
  });
}

async function testToolProviderSummaryHelper(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createAgentToolRegistry(config, policy);
    const summary = registry.getProviderSummaryForTool('read_file');
    assert.equal(summary.id, 'builtin');
    assert.equal(summary.kind, 'builtin');
    assert.equal(summary.access, 'read_write');
    assert.equal(summary.capabilities.includes('read_file'), true);
  });
}

async function testExternalReadonlyProviderGateReportsAccessReason(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const externalProvider = new StaticToolProvider('external-write-fixture', [{
      definition: {
        name: 'external_write_tool',
        description: 'disallowed external write fixture',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { ok: true };
      },
    }], {
      kind: 'external',
      access: 'read_write',
      capabilities: ['diagnostics'],
    });

    assert.throws(
      () => createAgentToolRegistry(config, policy, [externalProvider]),
      /external-write-fixture .*access=read_write.*must be read_only/,
    );
  });
}

async function testToolProviderDisposeSummary(): Promise<void> {
  await withWorkspace(async () => {
    const registry = new ToolRegistry();
    registry.registerProvider({
      id: 'dispose-summary-fixture',
      metadata: {
        kind: 'fixture',
        access: 'read_only',
      },
      listTools() {
        return [];
      },
      async executeTool() {
        return { ok: false, error: 'unused' };
      },
      async dispose() {
        return;
      },
    });

    const summary = await registry.disposeAll();
    assert.deepEqual(summary.disposedProviderIds, ['dispose-summary-fixture']);
  });
}

async function testToolLogIncludesProviderMetadata(): Promise<void> {
  await withWorkspace(async ({ config }) => {
    config.session.logToolBodies = true;
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['diagnostics-external-fixture'];

    const externalProvider = createExternalDiagnosticsFixtureProvider([
      {
        path: 'src/math.js',
        severity: 'warning',
        message: 'External provider check.',
        line: 2,
        column: 1,
        source: 'external-diagnostics-service',
      },
    ]);
    const policy = new PolicyEngine(config);
    const registry = createAgentToolRegistry(config, policy, [externalProvider]);
    const providers = new Map<string, ModelProvider>([['stub', new SequenceProvider([
      JSON.stringify({
        type: 'tool_call',
        tool: 'diagnostics_list',
        input: { path: 'src/math.js' },
      }),
      JSON.stringify({
        type: 'final',
        message: 'Diagnostics loaded.',
      }),
    ])]]);

    try {
      const result = await runAgent(config, providers, registry, {
        prompt: 'Load diagnostics only',
        explicitFiles: ['src/math.js'],
        pastedSnippets: [],
        manualVerifierCommands: [],
        autoApprove: true,
        confirm: async () => true,
      });
      assert.equal(result.status, 'completed');
      const logEntry = await assertToolLogEntry(
        result.sessionDir,
        'diagnostics_list',
        (record) => record.providerId === 'diagnostics-external-fixture',
        'Expected diagnostics tool log entry',
      );
      assert.equal(logEntry.providerKind, 'external');
      assert.equal(logEntry.providerAccess, 'read_only');
      assert.deepEqual(logEntry.providerCapabilities, ['diagnostics']);
      assert.equal(logEntry.diagnosticsSource, '[external-diagnostics]');
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testToolLogHelperIncludesProviderMetadata(): Promise<void> {
  const record = buildToolLogRecord({
    mode: 'agent',
    tool: 'diagnostics_list',
    input: { path: 'src/math.js' },
    result: { ok: true, data: [] },
    providerSummary: {
      id: 'diagnostics-external-fixture',
      kind: 'external',
      access: 'read_only',
      description: 'fixture',
      capabilities: ['diagnostics'],
    },
    logToolBodies: false,
  });

  assert.deepEqual(record, {
    mode: 'agent',
    tool: 'diagnostics_list',
    providerId: 'diagnostics-external-fixture',
    providerKind: 'external',
    providerAccess: 'read_only',
    providerCapabilities: ['diagnostics'],
    input: '[omitted]',
    result: { ok: true },
    diagnosticsSource: 'diagnostics-external-fixture',
    symbolsSource: '',
    referencesSource: '',
  });
}

async function testToolLogHelperIncludesCapabilitySourceFields(): Promise<void> {
  const symbolsRecord = buildToolLogRecord({
    mode: 'planner',
    tool: 'symbols_list',
    input: { path: 'src/math.js' },
    result: { ok: true, data: [{ name: 'multiply' }] },
    providerSummary: {
      id: 'local-symbols',
      kind: 'external',
      access: 'read_only',
      description: 'symbols',
      capabilities: ['symbols'],
    },
    logToolBodies: true,
  });
  assert.equal(symbolsRecord.diagnosticsSource, '');
  assert.equal(symbolsRecord.symbolsSource, 'local-symbols');
  assert.equal(symbolsRecord.referencesSource, '');

  const referencesRecord = buildToolLogRecord({
    mode: 'planner',
    tool: 'references_list',
    input: { path: 'src/router.js' },
    result: { ok: true, data: [{ symbolName: 'registerRoute' }] },
    providerSummary: {
      id: 'local-references',
      kind: 'external',
      access: 'read_only',
      description: 'references',
      capabilities: ['references'],
    },
    logToolBodies: true,
  });
  assert.equal(referencesRecord.diagnosticsSource, '');
  assert.equal(referencesRecord.symbolsSource, '');
  assert.equal(referencesRecord.referencesSource, 'local-references');
}
