import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, symlink, writeFile } from 'node:fs/promises';
import { runAgent } from '../../src/agent/index.js';
import { buildContext } from '../../src/context/index.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';
import { createBuiltinTools } from '../../src/tools/builtins.js';
import type { ModelProvider } from '../../src/provider/types.js';
import { withWorkspace } from './helpers.js';
import { InspectingProvider } from './providers.js';
import type { ManualSuiteCase } from './types.js';

export function createCoreCases(): ManualSuiteCase[] {
  return [
    { name: 'tool read/list/search', run: testReadListAndSearch },
    { name: 'automatic context selection', run: testAutomaticContextSelection },
    { name: 'git read only tools', run: testGitReadOnlyTools },
    { name: 'shell tools', run: testShellTools },
    { name: 'auto deny with explicit grant', run: testAutoDenyWithExplicitGrant },
    { name: 'policy blocks', run: testPolicyBlocks },
  ];
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
