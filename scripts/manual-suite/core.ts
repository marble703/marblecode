import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { runAgent } from '../../src/agent/index.js';
import { buildContext } from '../../src/context/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { createDiagnosticsFixtureProvider, createExternalDiagnosticsFixtureProvider } from '../../src/tools/diagnostics-provider.js';
import { createLocalDiagnosticsProvider } from '../../src/tools/local-diagnostics-provider.js';
import { createLocalReferencesProvider } from '../../src/tools/local-references-provider.js';
import { createLocalSymbolsProvider } from '../../src/tools/local-symbols-provider.js';
import { StaticToolProvider } from '../../src/tools/provider.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createAgentToolRegistry } from '../../src/tools/setup.js';
import { createBuiltinToolProvider, createBuiltinTools, createPlannerToolProvider } from '../../src/tools/builtins.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { withWorkspace } from './helpers.js';
import { InspectingProvider, SequenceProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createCoreCases(): ManualSuiteCase[] {
  return [
    { name: 'tool read/list/search', run: testReadListAndSearch },
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
    { name: 'automatic context selection', run: testAutomaticContextSelection },
    { name: 'git read only tools', run: testGitReadOnlyTools },
    { name: 'shell tools', run: testShellTools },
    { name: 'auto deny with explicit grant', run: testAutoDenyWithExplicitGrant },
    { name: 'policy blocks', run: testPolicyBlocks },
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
  await withWorkspace(async ({ config, workspaceRoot }) => {
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
      const logPath = path.join(result.sessionDir, 'tools.jsonl');
      const logContent = await readFile(logPath, 'utf8');
      assert.match(logContent, /"providerId":"diagnostics-external-fixture"/);
      assert.match(logContent, /"providerKind":"external"/);
      assert.match(logContent, /"providerAccess":"read_only"/);
      assert.match(logContent, /"providerCapabilities":\["diagnostics"\]/);
      assert.match(logContent, /"diagnosticsSource":"\[external-diagnostics\]"/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalDiagnosticsProviderReadsArtifact(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-diagnostics'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'diagnostics.json'), JSON.stringify({
      version: '1',
      diagnostics: [{
        path: 'src/math.js',
        severity: 'warning',
        message: 'Possible arithmetic mismatch.',
        line: 2,
        column: 10,
        source: 'local-diagnostics',
      }],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-diagnostics'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'diagnostics.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-diagnostics'];
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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-diagnostics'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'diagnostics.json'), JSON.stringify({
      version: '1',
      diagnostics: [{
        path: '../outside.txt',
        severity: 'error',
        message: 'Outside workspace.',
        line: 1,
        column: 1,
        source: 'local-diagnostics',
      }],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'symbols.json'), JSON.stringify({
      version: '1',
      symbols: [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'local-symbols',
      }],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'symbols.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'symbols.json'), JSON.stringify({
      version: '2',
      symbols: [],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'symbols.json'), JSON.stringify({
      version: '1',
      symbols: [{
        path: '../outside.txt',
        name: 'steal',
        kind: 'function',
        line: 1,
        column: 1,
        source: 'local-symbols',
      }],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-symbols'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'symbols.json'), JSON.stringify({
      version: '1',
      symbols: [{
        path: 'src/math.js',
        name: 'multiply',
        kind: 'function',
        line: 5,
        column: 1,
        source: 'workspace-symbol-index',
      }],
    }, null, 2), 'utf8');

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
      const logPath = path.join(result.sessionDir, 'tools.jsonl');
      const logContent = await readFile(logPath, 'utf8');
      assert.match(logContent, /"providerId":"local-symbols"/);
      assert.match(logContent, /"providerKind":"external"/);
      assert.match(logContent, /"providerAccess":"read_only"/);
      assert.match(logContent, /"providerCapabilities":\["symbols"\]/);
      assert.match(logContent, /"symbolsSource":"\[local-symbols\]"/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testLocalReferencesProviderReadsArtifact(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
      version: '2',
      references: [],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
      version: '1',
      references: [{
        path: '../outside.txt',
        symbolName: 'registerRoute',
        line: 1,
        column: 1,
        kind: 'reference',
        source: 'local-references',
      }],
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
    config.tools.externalProvidersEnabled = true;
    config.tools.allow = ['local-references'];
    await writeFile(path.join(workspaceRoot, '.marblecode', 'references.json'), JSON.stringify({
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
    }, null, 2), 'utf8');

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
      const logPath = path.join(result.sessionDir, 'tools.jsonl');
      const logContent = await readFile(logPath, 'utf8');
      assert.match(logContent, /"providerId":"local-references"/);
      assert.match(logContent, /"providerKind":"external"/);
      assert.match(logContent, /"providerAccess":"read_only"/);
      assert.match(logContent, /"providerCapabilities":\["references"\]/);
      assert.match(logContent, /"referencesSource":"\[local-references\]"/);
    } finally {
      await registry.disposeAll();
    }
  });
}

async function testReadListAndSearch(): Promise<void> {
  await withWorkspace(async ({ registry }) => {
    const readResult = await registry.execute({ name: 'read_file', input: { path: 'src/math.js' } });
    assert.equal(readResult.ok, true);
    assert.match(String((readResult.data as { content: string }).content), /BUG_MARKER/);

    const listResult = await registry.execute({ name: 'list_files', input: { path: 'src', pattern: '**/*.js' } });
    assert.equal(listResult.ok, true);
    assert.deepEqual(listResult.data, [
      'src/broken-syntax.js',
      'src/math.js',
      'src/register-routes.js',
      'src/router.js',
      'src/server.js',
    ]);

    const searchResult = await registry.execute({
      name: 'search_text',
      input: { pattern: 'BUG_MARKER|multiply', pathPattern: 'src/**/*.js' },
    });
    assert.equal(searchResult.ok, true);
    const matches = searchResult.data as Array<{
      path: string;
      count: number;
      matches: Array<{ line: number; column: number; match: string; context: string }>;
    }>;
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.path, 'src/math.js');
    assert.equal(matches[0]?.count, 2);
    assert.equal(matches[0]?.matches[0]?.line, 2);
    assert.ok((matches[0]?.matches[0]?.column ?? 0) > 1);
    assert.match(matches[0]?.matches[0]?.context ?? '', /BUG_MARKER/);
    assert.equal(matches[0]?.matches[1]?.line, 5);
  });
}

async function testAutomaticContextSelection(): Promise<void> {
  await withWorkspace(async ({ config, policy, registry }) => {
    const pastedSnippet = 'registerRoute(router, "/health", handler);';
    const autoContext = await buildContext(
      {
        prompt: '修复路由重复注册问题',
        explicitFiles: [],
        pastedSnippets: [pastedSnippet],
      },
      config,
      policy,
    );

    assert.ok(autoContext.queryTerms.includes('路由'));
    assert.ok(autoContext.queryTerms.includes('router'));
    assert.ok(autoContext.queryTerms.includes('注册'));
    assert.ok(autoContext.queryTerms.includes('register'));
    assert.equal(autoContext.items[0]?.path, '[Pasted ~1 lines #1]');
    assert.ok(autoContext.items.some((item) => item.path === 'src/router.js'));
    assert.ok(autoContext.items.some((item) => item.path === 'src/register-routes.js'));
    assert.match(autoContext.selectionSummary, /Context selection summary:/);
    assert.match(autoContext.selectionSummary, /src\/router\.js/);
    assert.match(autoContext.selectionSummary, /路由, route, router/);

    const explicitContext = await buildContext(
      {
        prompt: '修复路由重复注册问题',
        explicitFiles: ['src/server.js'],
        pastedSnippets: [],
      },
      config,
      policy,
    );
    assert.equal(explicitContext.items[0]?.path, 'src/server.js');
    assert.equal(explicitContext.items[0]?.source, 'explicit');

    const providers = new Map<string, ModelProvider>([['stub', new InspectingProvider((request) => {
      assert.match(request.systemPrompt ?? '', /search before editing/);
      assert.match(request.systemPrompt ?? '', /multiple operations/);
      const content = request.messages[0]?.content ?? '';
      assert.match(content, /Context selection summary:/);
      assert.match(content, /src\/router\.js/);
      assert.match(content, /src\/register-routes\.js/);
      assert.match(content, /\[Pasted ~1 lines #1\]/);
    })]]);
    const result = await runAgent(config, providers, registry, {
      prompt: '修复路由重复注册问题',
      explicitFiles: [],
      pastedSnippets: [pastedSnippet],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.changedFiles.length, 0);
  });
}

async function testGitReadOnlyTools(): Promise<void> {
  await withWorkspace(async ({ registry, workspaceRoot }) => {
    const init = await registry.execute({ name: 'run_shell', input: { command: 'git init' } });
    assert.equal(init.ok, true);
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git config user.email suite@example.com' } })).ok, true);
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git config user.name "Manual Suite"' } })).ok, true);
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git add .' } })).ok, true);
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git commit -m "initial fixture"' } })).ok, true);

    await writeFile(path.join(workspaceRoot, 'src', 'notes.txt'), 'notes v2\n', 'utf8');
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git add src/notes.txt' } })).ok, true);
    assert.equal((await registry.execute({ name: 'run_shell', input: { command: 'git commit -m "update notes"' } })).ok, true);
    await writeFile(path.join(workspaceRoot, 'src', 'math.js'), 'export function add(a, b) {\n  return a - b; // BUG_MARKER\n}\n\nexport function multiply(a, b) {\n  return a * b;\n}\n// local change\n', 'utf8');

    const status = await registry.execute({ name: 'git_status', input: { short: true } });
    assert.equal(status.ok, true);
    assert.match(status.stdout ?? '', /src\/math\.js/);

    const log = await registry.execute({ name: 'git_log', input: { count: 1 } });
    assert.equal(log.ok, true);
    assert.match(log.stdout ?? '', /update notes/);

    const show = await registry.execute({ name: 'git_show', input: { ref: 'HEAD', path: 'src/notes.txt' } });
    assert.equal(show.ok, true);
    assert.match(show.stdout ?? '', /notes v2/);

    const diffBase = await registry.execute({ name: 'git_diff_base', input: { baseRef: 'HEAD~1', targetRef: 'HEAD', path: 'src/notes.txt' } });
    assert.equal(diffBase.ok, true);
    assert.match(diffBase.stdout ?? '', /notes v2/);
  });
}

async function testShellTools(): Promise<void> {
  await withWorkspace(async ({ registry, workspaceRoot }) => {
    const pwdResult = await registry.execute({ name: 'run_shell', input: { command: 'pwd' } });
    assert.equal(pwdResult.ok, true);
    assert.equal(pwdResult.stdout?.trim(), workspaceRoot);

    const lsResult = await registry.execute({ name: 'run_shell', input: { command: 'ls src' } });
    assert.equal(lsResult.ok, true);
    assert.match(lsResult.stdout ?? '', /math\.js/);

    const grepResult = await registry.execute({ name: 'run_shell', input: { command: 'grep -n "BUG_MARKER" src/math.js' } });
    assert.equal(grepResult.ok, true);
    assert.match(grepResult.stdout ?? '', /^2:.*BUG_MARKER/m);

    const blockedSubshell = await registry.execute({ name: 'run_shell', input: { command: 'echo $(pwd)' } });
    assert.equal(blockedSubshell.ok, false);
    assert.match(blockedSubshell.error ?? '', /blocked shell syntax/i);
  });
}

async function testAutoDenyWithExplicitGrant(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot, tempRoot }) => {
    config.context.autoDeny = ['src/notes.txt'];
    const blockedPolicy = new PolicyEngine(config);
    const blockedRegistry = new ToolRegistry();
    for (const tool of createBuiltinTools(config, blockedPolicy)) {
      blockedRegistry.register(tool);
    }

    const blockedRead = await blockedRegistry.execute({ name: 'read_file', input: { path: 'src/notes.txt' } });
    assert.equal(blockedRead.ok, false);
    assert.match(blockedRead.error ?? '', /Auto read access blocked/);

    const explicitPolicy = new PolicyEngine(config, {
      grantedReadPaths: ['src/notes.txt', '../outside.txt'],
      grantedWritePaths: ['src/notes.txt', '../outside.txt'],
    });
    const explicitRegistry = new ToolRegistry();
    for (const tool of createBuiltinTools(config, explicitPolicy)) {
      explicitRegistry.register(tool);
    }

    const explicitRead = await explicitRegistry.execute({ name: 'read_file', input: { path: 'src/notes.txt' } });
    assert.equal(explicitRead.ok, true);

    const outsideRead = await explicitRegistry.execute({ name: 'read_file', input: { path: '../outside.txt' } });
    assert.equal(outsideRead.ok, true);
    assert.match(String((outsideRead.data as { content: string }).content), /blocked/);

    const autoContext = await buildContext(
      {
        prompt: 'FIX_ME_42',
        explicitFiles: [],
        pastedSnippets: [],
      },
      config,
      blockedPolicy,
    );
    assert.ok(!autoContext.items.some((item) => item.path === 'src/notes.txt'));

    const explicitContext = await buildContext(
      {
        prompt: 'FIX_ME_42',
        explicitFiles: ['src/notes.txt', '../outside.txt'],
        pastedSnippets: [],
      },
      config,
      explicitPolicy,
    );
    assert.ok(explicitContext.items.some((item) => item.path === 'src/notes.txt'));
    assert.ok(explicitContext.items.some((item) => item.path === '../outside.txt'));

    assert.throws(() => new PolicyEngine(config, { grantedWritePaths: ['../outside.txt'] }).assertWritable(path.join(tempRoot, 'outside.txt')));
    assert.equal(workspaceRoot.endsWith('/workspace'), true);
  });
}

async function testPolicyBlocks(): Promise<void> {
  await withWorkspace(async ({ registry, tempRoot, workspaceRoot }) => {
    const sensitiveRead = await registry.execute({ name: 'read_file', input: { path: '.env' } });
    assert.equal(sensitiveRead.ok, false);
    assert.match(sensitiveRead.error ?? '', /Sensitive files/);

    const outsideRead = await registry.execute({ name: 'read_file', input: { path: '../outside.txt' } });
    assert.equal(outsideRead.ok, false);
    assert.match(outsideRead.error ?? '', /Read access denied/);

    const blockedShell = await registry.execute({ name: 'run_shell', input: { command: 'curl https://example.com' } });
    assert.equal(blockedShell.ok, false);
    assert.match(blockedShell.error ?? '', /blocked by policy|matched blocked pattern/);

    const envInjectedShell = await registry.execute({ name: 'run_shell', input: { command: 'FOO=bar pwd' } });
    assert.equal(envInjectedShell.ok, false);
    assert.match(envInjectedShell.error ?? '', /Inline environment variable assignments are blocked/);

    const shellChain = await registry.execute({ name: 'run_shell', input: { command: 'pwd && ls' } });
    assert.equal(shellChain.ok, false);
    assert.match(shellChain.error ?? '', /blocked shell syntax/i);

    await symlink(path.join(tempRoot, 'outside.txt'), path.join(workspaceRoot, 'src', 'outside-link.txt'));
    const symlinkRead = await registry.execute({ name: 'read_file', input: { path: 'src/outside-link.txt' } });
    assert.equal(symlinkRead.ok, false);
    assert.match(symlinkRead.error ?? '', /Read access denied/);
  });
}
