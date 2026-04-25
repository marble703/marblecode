import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../../src/config/load.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { runVerifier } from '../../src/verifier/index.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { withCopiedFixture, withWorkspace } from './helpers.js';
import { StaticAnalysisProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createVerifierCases(): ManualSuiteCase[] {
  return [
    { name: 'verifier auto discovery', run: testVerifierAutoDiscovery },
    { name: 'verifier syntax error output', run: testVerifierSyntaxErrorOutput },
    { name: 'verifier failure analysis', run: testVerifierFailureAnalysis },
  ];
}

async function testVerifierAutoDiscovery(): Promise<void> {
  await withWorkspace(async ({ workspaceRoot }) => {
    await rm(path.join(workspaceRoot, '.marblecode', 'verifier.md'));
    const fixedMath = `export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}
`;
    await writeFile(path.join(workspaceRoot, 'src/math.js'), fixedMath, 'utf8');

    const config = await loadConfig(path.join(workspaceRoot, 'agent.config.jsonc'));
    const verifyResult = await runVerifier(config, new PolicyEngine(config), {
      changedFiles: ['src/math.js'],
    });

    assert.equal(verifyResult.success, true);
    assert.equal(verifyResult.commands[0]?.source, 'discovered');
    assert.equal(verifyResult.commands[0]?.command, 'npm run test');
  });

  await withCopiedFixture(fileURLToPath(new URL('../../examples/verifier-fixture/', import.meta.url)), async ({ workspaceRoot }) => {
    await rm(path.join(workspaceRoot, '.marblecode'), { recursive: true, force: true });
    await writeFile(
      path.join(workspaceRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'discovery-build-fixture',
          private: true,
          type: 'module',
          scripts: {
            build: 'node --eval "process.stdout.write(\'build ok\\n\')"',
          },
        },
        null,
        2,
      ),
      'utf8',
    );

    const config = await loadConfig(path.join(workspaceRoot, 'agent.config.jsonc'));
    const verifyResult = await runVerifier(config, new PolicyEngine(config), {
      changedFiles: ['src/index.ts'],
    });

    assert.equal(verifyResult.success, true);
    assert.equal(verifyResult.commands[0]?.source, 'discovered');
    assert.equal(verifyResult.commands[0]?.command, 'npm run build');
  });
}

async function testVerifierSyntaxErrorOutput(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const verifyResult = await runVerifier(config, policy, {
      manualCommands: ['node --check src/broken-syntax.js'],
    });

    assert.equal(verifyResult.success, false);
    assert.equal(verifyResult.failures.length, 1);
    assert.equal(verifyResult.failures[0]?.source, 'manual');
    assert.ok((verifyResult.failures[0]?.stderr.length ?? 0) > 0);
    assert.match(verifyResult.failures[0]?.stderr ?? '', /SyntaxError|Unexpected token/);
  });
}

async function testVerifierFailureAnalysis(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    config.verifier.autoAnalyzeFailures = true;
    const providers = new Map<string, ModelProvider>([['stub', new StaticAnalysisProvider()]]);
    const verifyResult = await runVerifier(config, policy, {
      manualCommands: ['node --eval "process.exit(2)"'],
      changedFiles: ['src/math.js'],
      providers,
    });

    assert.equal(verifyResult.success, false);
    assert.equal(verifyResult.analysis?.shouldEditVerifier, true);
    assert.match(verifyResult.analysis?.summary ?? '', /stale/);
    assert.equal(verifyResult.analysis?.confidence, 'high');
  });
}
