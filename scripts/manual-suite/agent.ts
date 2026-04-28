import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { runAgent, tryRollback } from '../../src/agent/index.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { buildMathFixStep, buildMultiFileFixStep, withWorkspace } from './helpers.js';
import { FlakyProvider, StaticPatchProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createAgentCases(): ManualSuiteCase[] {
  return [
    { name: 'agent model retry', run: testAgentModelRetry },
    { name: 'agent model retry exhaustion', run: testAgentModelRetryExhaustion },
    { name: 'agent final response completes', run: testAgentFinalResponseCompletes },
    { name: 'patch apply and verifier', run: testPatchApplyAndVerifier },
    { name: 'restricted write scope blocks extra file', run: testRestrictedWriteScopeBlocksExtraFile },
    { name: 'multi-file patch apply', run: testMultiFilePatchApply },
    { name: 'patch rejection', run: testPatchRejection },
    { name: 'patch baseline drift', run: testPatchBaselineDrift },
    { name: 'rollback restore', run: testRollbackRestore },
  ];
}

async function testMultiFilePatchApply(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMultiFileFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js and update the related notes in one change.',
      explicitFiles: ['src/math.js', 'src/notes.txt'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.changedFiles, ['src/math.js', 'src/notes.txt']);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    assert.match(await readFile(path.join(workspaceRoot, 'src/notes.txt'), 'utf8'), /FIXED_NOTE/);

    const patchArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'patch.json'), 'utf8')) as {
      operations: Array<{ path: string }>;
    };
    assert.equal(patchArtifact.operations.length, 2);
    assert.deepEqual(
      patchArtifact.operations.map((operation) => operation.path),
      ['src/math.js', 'src/notes.txt'],
    );
  });
}

async function testAgentFinalResponseCompletes(): Promise<void> {
  await withWorkspace(async ({ config, registry }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => JSON.stringify({
      type: 'final',
      thought: 'The request only needs an answer, not file edits.',
      message: 'Explained the issue without changing files.',
    }))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Explain what the add function currently does.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
      routeOverride: {
        modelAlias: 'code',
        intent: 'question',
        maxSteps: 4,
        maxAutoRepairAttempts: 0,
      },
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.changedFiles, []);
    assert.equal(result.message, 'Explained the issue without changing files.');
    assert.equal(result.modelAlias, 'code');
  });
}

async function testPatchApplyAndVerifier(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMathFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    assert.equal(result.status, 'completed');
    assert.deepEqual(result.changedFiles, ['src/math.js']);
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);

    const patchArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'patch.json'), 'utf8')) as { summary: string };
    const verifyArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'verify.json'), 'utf8')) as { success: boolean; commands: Array<{ command: string }> };
    assert.match(patchArtifact.summary, /Fix the add function/);
    assert.equal(verifyArtifact.success, true);
    assert.equal(verifyArtifact.commands[0]?.command, 'npm test');
  });
}

async function testRestrictedWriteScopeBlocksExtraFile(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMultiFileFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js but do not touch any other file.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
      policyOptions: {
        grantedReadPaths: ['src/math.js'],
        grantedWritePaths: ['src/math.js'],
        restrictWritePaths: true,
      },
    });

    assert.equal(result.status, 'needs_intervention');
    assert.match(result.message, /write access denied/i);
  });
}

async function testAgentModelRetry(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    config.session.modelRetryAttempts = 3;
    config.session.modelRetryDelayMs = 1;
    const providers = new Map<string, ModelProvider>([['stub', new FlakyProvider(2, async () => buildMathFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    assert.equal(result.status, 'completed');
    const retries = await readFile(path.join(result.sessionDir, 'model.retries.jsonl'), 'utf8');
    assert.match(retries, /rate limit/i);
  });
}

async function testAgentModelRetryExhaustion(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    config.session.modelRetryAttempts = 2;
    config.session.modelRetryDelayMs = 1;
    const providers = new Map<string, ModelProvider>([['stub', new FlakyProvider(10, async () => buildMathFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    assert.equal(result.status, 'needs_intervention');
    assert.match(result.message, /failed after 2 retries/i);
    const modelError = JSON.parse(await readFile(path.join(result.sessionDir, 'model-error.json'), 'utf8')) as { retryAttempts: number; error: string };
    assert.equal(modelError.retryAttempts, 2);
    assert.match(modelError.error, /429|rate limit/i);
  });
}

async function testPatchRejection(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const before = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMathFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: false,
      confirm: async () => false,
    });

    assert.equal(result.status, 'needs_intervention');
    assert.match(result.message, /Patch preview rejected/);
    assert.equal(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), before);
    assert.match(await readFile(path.join(result.sessionDir, 'patch.preview.txt'), 'utf8'), /return a \+ b;/);
  });
}

async function testPatchBaselineDrift(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMathFixStep(workspaceRoot))]]);
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: false,
      confirm: async () => {
        await writeFile(path.join(workspaceRoot, 'src/math.js'), 'export function add(a, b) {\n  return a * b;\n}\n', 'utf8');
        return true;
      },
    });

    assert.equal(result.status, 'needs_intervention');
    assert.match(result.message, /baseline drift/i);
    assert.match(result.message, /Refresh context and regenerate the patch/i);
  });
}

async function testRollbackRestore(): Promise<void> {
  await withWorkspace(async ({ config, registry, workspaceRoot }) => {
    const providers = new Map<string, ModelProvider>([['stub', new StaticPatchProvider(async () => buildMathFixStep(workspaceRoot))]]);
    const before = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
    const result = await runAgent(config, providers, registry, {
      prompt: 'Fix src/math.js so add returns the correct sum.',
      explicitFiles: ['src/math.js'],
      pastedSnippets: [],
      manualVerifierCommands: [],
      autoApprove: true,
      confirm: async () => true,
    });

    const rollback = JSON.parse(await readFile(path.join(result.sessionDir, 'rollback.json'), 'utf8')) as Parameters<typeof tryRollback>[1];
    await tryRollback(config, rollback);
    assert.equal(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), before);
  });
}
