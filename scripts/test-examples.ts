import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runAgent, tryRollback } from '../src/agent/index.js';
import { loadConfig } from '../src/config/load.js';
import { buildContext } from '../src/context/index.js';
import { runPlanner } from '../src/planner/index.js';
import { PolicyEngine } from '../src/policy/index.js';
import { resolvePlannerSessionDir } from '../src/session/index.js';
import { applyTuiCommand, createInitialTuiState } from '../src/tui/agent-repl.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createBuiltinTools, createPlannerTools } from '../src/tools/builtins.js';
import { runVerifier } from '../src/verifier/index.js';
import type { AppConfig } from '../src/config/schema.js';
import type { ModelProvider, ModelRequest, ModelResponse } from '../src/provider/types.js';

const SUITE_ROOT = fileURLToPath(new URL('../examples/manual-test-suite/project/', import.meta.url));

class StaticPatchProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(private readonly patchFactory: (request: ModelRequest) => Promise<string> | string) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    return {
      content: await this.patchFactory(request),
    };
  }
}

class StaticAnalysisProvider implements ModelProvider {
  public readonly id = 'stub';
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
        shouldEditVerifier: true,
        summary: 'Manual verifier command is stale.',
        reason: 'The provided command exits immediately and does not validate project state.',
        confidence: 'high',
        suggestedVerifierChanges: ['Use the markdown-defined npm test step instead of the manual failing command.'],
        suggestedCodeChanges: [],
      }),
    };
  }
}

class InspectingProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(private readonly inspect: (request: ModelRequest) => void) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.inspect(request);
    return {
      content: JSON.stringify({
        type: 'final',
        message: 'inspected context request',
      }),
    };
  }
}

class SequenceProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  private index = 0;

  public constructor(
    private readonly responses: Array<string | ((request: ModelRequest, index: number) => string | Promise<string>)>,
    private readonly inspect?: (request: ModelRequest, index: number) => void,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    const currentIndex = this.index;
    const response = this.responses[currentIndex];
    if (!response) {
      throw new Error(`Unexpected planner/model request index ${currentIndex}`);
    }

    this.inspect?.(request, currentIndex);
    this.index += 1;
    return {
      content: typeof response === 'string' ? response : await response(request, currentIndex),
    };
  }
}

class FlakyProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  private attempts = 0;

  public constructor(
    private readonly failuresBeforeSuccess: number,
    private readonly successFactory: (request: ModelRequest, attempt: number) => Promise<string> | string,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    this.attempts += 1;
    if (this.attempts <= this.failuresBeforeSuccess) {
      throw new Error('Provider request failed with status 429: {"error":{"message":"Upstream rate limit exceeded, please retry later"}}');
    }

    return {
      content: await this.successFactory(request, this.attempts),
    };
  }
}

class BranchingProvider implements ModelProvider {
  public readonly id = 'stub';
  public readonly capabilities = {
    streaming: false,
    toolCalling: false,
    responseChunks: false,
    reasoningTokens: false,
    separateSystemPrompt: true,
  } as const;

  public constructor(
    private readonly handler: (request: ModelRequest) => Promise<string> | string,
  ) {}

  public async invoke(request: ModelRequest): Promise<ModelResponse> {
    return {
      content: await this.handler(request),
    };
  }
}

async function main(): Promise<void> {
  const cases: Array<{ name: string; run: () => Promise<void> }> = [
    { name: 'tool read/list/search', run: testReadListAndSearch },
    { name: 'automatic context selection', run: testAutomaticContextSelection },
    { name: 'planner read-only flow', run: testPlannerReadOnlyFlow },
    { name: 'planner invalid retry and resume', run: testPlannerInvalidRetryAndResume },
    { name: 'planner model retry', run: testPlannerModelRetry },
    { name: 'planner model retry exhaustion', run: testPlannerModelRetryExhaustion },
    { name: 'planner session resolution', run: testPlannerSessionResolution },
    { name: 'interactive tui command parsing', run: testInteractiveTuiCommandParsing },
    { name: 'auto deny with explicit grant', run: testAutoDenyWithExplicitGrant },
    { name: 'planner execute chain', run: testPlannerExecuteChain },
    { name: 'shell tools', run: testShellTools },
    { name: 'policy blocks', run: testPolicyBlocks },
    { name: 'verifier auto discovery', run: testVerifierAutoDiscovery },
    { name: 'agent model retry', run: testAgentModelRetry },
    { name: 'agent model retry exhaustion', run: testAgentModelRetryExhaustion },
    { name: 'patch apply and verifier', run: testPatchApplyAndVerifier },
    { name: 'multi-file patch apply', run: testMultiFilePatchApply },
    { name: 'patch rejection', run: testPatchRejection },
    { name: 'rollback restore', run: testRollbackRestore },
    { name: 'verifier syntax error output', run: testVerifierSyntaxErrorOutput },
    { name: 'verifier failure analysis', run: testVerifierFailureAnalysis },
  ];

  let completed = 0;
  for (const testCase of cases) {
    process.stdout.write(`case:start ${testCase.name}\n`);
    await testCase.run();
    completed += 1;
    process.stdout.write(`case:ok ${testCase.name}\n`);
  }

  process.stdout.write(`manual example suite ok (${completed} cases)\n`);
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
  });
}

async function testPlannerReadOnlyFlow(): Promise<void> {
  await withWorkspace(async ({ config, policy, workspaceRoot }) => {
    const registry = createPlannerRegistry(config, policy);
    const provider = new SequenceProvider(
      [
        JSON.stringify({
          type: 'plan',
          plan: {
            version: '1',
            summary: 'Refactor the router module and add tests.',
            steps: [
              {
                id: 'step-1',
                title: '查找 router 相关文件',
                status: 'PENDING',
                kind: 'search',
                details: '定位 router/register/export/test 相关实现和入口。',
                dependencies: [],
                children: [],
              },
              {
                id: 'step-2',
                title: '修改路由逻辑',
                status: 'PENDING',
                kind: 'code',
                dependencies: ['step-1'],
                children: [],
              },
              {
                id: 'step-3',
                title: '更新测试',
                status: 'PENDING',
                kind: 'test',
                dependencies: ['step-2'],
                children: [],
              },
              {
                id: 'step-4',
                title: '执行 verify',
                status: 'PENDING',
                kind: 'verify',
                dependencies: ['step-3'],
                children: [],
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'plan_update',
          stepId: 'step-1',
          status: 'SEARCHING',
          message: 'Searching router and register files.',
          relatedFiles: ['src/router.js', 'src/register-routes.js'],
        }),
        JSON.stringify({
          type: 'tool_call',
          tool: 'search_text',
          input: {
            pattern: 'registerRoute|router',
            pathPattern: 'src/**/*.js',
          },
        }),
        JSON.stringify({
          type: 'plan_update',
          stepId: 'step-1',
          status: 'DONE',
          message: 'Identified the router implementation and registration entry points.',
          relatedFiles: ['src/router.js', 'src/register-routes.js', 'src/server.js'],
        }),
        JSON.stringify({
          type: 'final',
          outcome: 'DONE',
          message: 'Plan captured and ready for execution.',
          summary: '1. 查找 router 相关文件 2. 修改路由逻辑 3. 更新测试 4. 执行 verify',
        }),
      ],
      (request, index) => {
        if (index === 0) {
          assert.match(request.systemPrompt ?? '', /read-only/i);
          assert.doesNotMatch(request.messages[0]?.content ?? '', /run_shell/);
          assert.match(request.messages[0]?.content ?? '', /\[Pasted ~1 lines #1\]/);
          assert.match(request.messages[0]?.content ?? '', /Subtask context packet template:/);
        }
      },
    );

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '重构路由模块并补测试',
      explicitFiles: [],
      pastedSnippets: ['registerRoute(router, "/health", handler);'],
    });

    assert.equal(result.status, 'completed');
    const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as {
      revision: number;
      summary: string;
      steps: Array<{ id: string; status: string; relatedFiles?: string[] }>;
    };
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as {
      outcome: string;
      phase: string;
      message: string;
    };
    const contextPacket = JSON.parse(await readFile(path.join(result.sessionDir, 'planner.context.packet.json'), 'utf8')) as {
      constraints: { readOnly: boolean; allowedTools: string[] };
      queryTerms: string[];
    };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    const toolsLog = await readFile(path.join(result.sessionDir, 'tools.jsonl'), 'utf8');

    assert.equal(plan.revision, 1);
    assert.match(plan.summary, /1\. 查找 router/);
    assert.equal(plan.steps[0]?.status, 'DONE');
    assert.deepEqual(plan.steps[0]?.relatedFiles, ['src/router.js', 'src/register-routes.js', 'src/server.js']);
    assert.equal(state.outcome, 'DONE');
    assert.equal(contextPacket.constraints.readOnly, true);
    assert.deepEqual(contextPacket.constraints.allowedTools, ['read_file', 'list_files', 'search_text', 'git_diff']);
    assert.ok(contextPacket.queryTerms.includes('router'));
    assert.match(events, /planner_started/);
    assert.match(events, /plan_step_updated/);
    assert.match(plannerLog, /"type":"plan_snapshot"/);
    assert.match(plannerLog, /"type":"planner_terminal"/);
    assert.match(toolsLog, /search_text/);
    assert.equal(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), await readFile(path.join(SUITE_ROOT, 'src/math.js'), 'utf8'));
  });
}

async function testPlannerInvalidRetryAndResume(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    const provider = new SequenceProvider([
      JSON.stringify({
        type: 'patch',
        patch: {
          version: '1',
          summary: 'should fail in planner mode',
          operations: [],
        },
      }),
      JSON.stringify({
        type: 'plan',
        plan: {
          version: '1',
          summary: 'Need more information before planning the route refactor.',
          steps: [
            {
              id: 'step-1',
              title: 'Clarify target API surface',
              status: 'PENDING',
              kind: 'search',
              dependencies: [],
              children: [],
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'final',
        outcome: 'NEEDS_INPUT',
        message: 'Need the target route export surface before planning the refactor.',
      }),
    ]);

    const first = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '重构路由模块并补测试',
      explicitFiles: [],
      pastedSnippets: [],
    });

    assert.equal(first.status, 'needs_input');
    const firstEvents = await readFile(path.join(first.sessionDir, 'plan.events.jsonl'), 'utf8');
    const firstPlannerLog = await readFile(path.join(first.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.match(firstEvents, /planner_invalid_output/);
    assert.match(firstPlannerLog, /"type":"invalid_response"/);
    const firstState = JSON.parse(await readFile(path.join(first.sessionDir, 'plan.state.json'), 'utf8')) as {
      revision: number;
      outcome: string;
    };
    assert.equal(firstState.revision, 1);
    assert.equal(firstState.outcome, 'NEEDS_INPUT');

    const resumedProvider = new SequenceProvider([
      (request) => {
        assert.match(request.messages[0]?.content ?? '', /Current plan:/);
        assert.match(request.messages[0]?.content ?? '', /Additional planner input:/);
        return JSON.stringify({
          type: 'plan',
          plan: {
            version: '1',
            summary: 'Replanned route refactor with clarified export surface.',
            steps: [
              {
                id: 'step-1',
                title: '查找 router 相关文件',
                status: 'DONE',
                kind: 'search',
                dependencies: [],
                children: [],
              },
              {
                id: 'step-2',
                title: '修改路由逻辑',
                status: 'PENDING',
                kind: 'code',
                dependencies: ['step-1'],
                children: [],
              },
            ],
          },
        });
      },
      JSON.stringify({
        type: 'final',
        outcome: 'DONE',
        message: 'Replanned with the new route export information.',
      }),
    ]);

    const resumed = await runPlanner(config, new Map([['stub', resumedProvider]]), registry, {
      prompt: '新的输入：还需要保留现有导出结构。',
      explicitFiles: [],
      pastedSnippets: [],
      resumeSessionRef: first.sessionDir,
    });

    assert.equal(resumed.status, 'completed');
    assert.equal(resumed.sessionDir, first.sessionDir);
    const requestArtifact = JSON.parse(await readFile(path.join(resumed.sessionDir, 'planner.request.json'), 'utf8')) as {
      promptHistory: string[];
    };
    const finalPlan = JSON.parse(await readFile(path.join(resumed.sessionDir, 'plan.json'), 'utf8')) as {
      revision: number;
      summary: string;
    };
    const finalEvents = await readFile(path.join(resumed.sessionDir, 'plan.events.jsonl'), 'utf8');

    assert.deepEqual(requestArtifact.promptHistory, ['重构路由模块并补测试', '新的输入：还需要保留现有导出结构。']);
    assert.equal(finalPlan.revision, 2);
    assert.match(finalPlan.summary, /Replanned/);
    assert.match(finalEvents, /planner_replanned/);
  });
}

async function testPlannerModelRetry(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    config.session.modelRetryAttempts = 3;
    config.session.modelRetryDelayMs = 1;
    const provider = new FlakyProvider(2, () => JSON.stringify({
      type: 'final',
      outcome: 'DONE',
      message: 'Planner completed after retrying transient rate limits.',
      summary: 'retry ok',
    }));

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '为路由模块生成一个简短计划',
      explicitFiles: ['src/router.js'],
      pastedSnippets: [],
    });

    assert.equal(result.status, 'completed');
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.match(events, /planner_model_retry/);
    assert.match(plannerLog, /"type":"model_retry"/);
  });
}

async function testPlannerModelRetryExhaustion(): Promise<void> {
  await withWorkspace(async ({ config, policy }) => {
    const registry = createPlannerRegistry(config, policy);
    config.session.modelRetryAttempts = 2;
    config.session.modelRetryDelayMs = 1;
    const provider = new FlakyProvider(10, () => JSON.stringify({ type: 'final', outcome: 'DONE', message: 'unreachable' }));

    const result = await runPlanner(config, new Map([['stub', provider]]), registry, {
      prompt: '为路由模块生成一个简短计划',
      explicitFiles: ['src/router.js'],
      pastedSnippets: [],
    });

    assert.equal(result.status, 'failed');
    assert.match(result.message, /failed after 2 retries/i);
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { outcome: string; message: string };
    const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');
    assert.equal(state.outcome, 'FAILED');
    assert.match(state.message, /429|failed after 2 retries/i);
    assert.match(plannerLog, /"type":"model_failure"/);
  });
}

async function testPlannerSessionResolution(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const sessionsDir = path.join(workspaceRoot, '.agent', 'sessions');
    const childSessionDir = path.join(sessionsDir, '2026-04-20T10-00-00-000Z');
    const plannerSessionDir = path.join(sessionsDir, '2026-04-20T10-00-01-000Z');
    await mkdir(childSessionDir, { recursive: true });
    await mkdir(plannerSessionDir, { recursive: true });
    await writeFile(path.join(childSessionDir, 'request.json'), '{}', 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.json'), JSON.stringify({ summary: '', steps: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.state.json'), JSON.stringify({ outcome: 'DONE', phase: 'PENDING', currentStepId: null, consistencyErrors: [] }), 'utf8');
    await writeFile(path.join(plannerSessionDir, 'plan.events.jsonl'), JSON.stringify({ type: 'planner_finished' }) + '\n', 'utf8');

    const resolved = await resolvePlannerSessionDir(config, undefined, true);
    assert.equal(resolved, plannerSessionDir);
  });
}

async function testInteractiveTuiCommandParsing(): Promise<void> {
  let state = createInitialTuiState();
  state = applyTuiCommand(state, '/mode execute').state;
  assert.equal(state.mode, 'execute');
  state = applyTuiCommand(state, '/workspace /tmp/example-workspace').state;
  assert.equal(state.workspaceRoot, '/tmp/example-workspace');
  state = applyTuiCommand(state, '/files src/math.js tests/check-math.js').state;
  assert.deepEqual(state.explicitFiles, ['src/math.js', 'tests/check-math.js']);
  state = applyTuiCommand(state, '/verify npm test').state;
  assert.deepEqual(state.manualVerifierCommands, ['npm test']);
  state = applyTuiCommand(state, '/yes on').state;
  assert.equal(state.autoApprove, true);
  state = applyTuiCommand(state, '/clear-files').state;
  assert.deepEqual(state.explicitFiles, []);
  state = applyTuiCommand(state, '/reset').state;
  assert.equal(state.mode, 'run');
  assert.equal(state.autoApprove, false);
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
  });
}

async function testPlannerExecuteChain(): Promise<void> {
  await withWorkspace(async ({ config, workspaceRoot }) => {
    const provider = new BranchingProvider(async (request) => {
      if (request.metadata?.mode === 'planner-json-loop') {
        const currentPlan = request.messages[0]?.content ?? '';
        if (!currentPlan.includes('"id": "step-1"') && !currentPlan.includes('"id":"step-1"')) {
          return JSON.stringify({
            type: 'plan',
            plan: {
              version: '1',
              summary: 'Fix the add bug and run final verify.',
              steps: [
                {
                  id: 'step-1',
                  title: 'Inspect math bug',
                  status: 'PENDING',
                  kind: 'search',
                  details: 'Review src/math.js and tests/check-math.js.',
                  relatedFiles: ['src/math.js', 'tests/check-math.js'],
                  dependencies: [],
                  children: [],
                },
                {
                  id: 'step-2',
                  title: 'Fix the add implementation',
                  status: 'PENDING',
                  kind: 'code',
                  details: 'Change add so it returns a + b.',
                  relatedFiles: ['src/math.js'],
                  dependencies: ['step-1'],
                  children: [],
                },
                {
                  id: 'step-3',
                  title: 'Run final verify',
                  status: 'PENDING',
                  kind: 'verify',
                  details: 'Run the project verifier.',
                  dependencies: ['step-2'],
                  children: [],
                },
              ],
            },
          });
        }

        return JSON.stringify({
          type: 'final',
          outcome: 'DONE',
          message: 'Plan complete',
          summary: 'Fix the add bug and run final verify.',
        });
      }

      if (request.metadata?.mode === 'mvp-json-loop') {
        return buildMathFixStep(workspaceRoot);
      }

      throw new Error(`Unexpected request mode: ${String(request.metadata?.mode ?? '')}`);
    });

    const plannerRegistry = createPlannerRegistry(config, new PolicyEngine(config));
    const result = await runPlanner(config, new Map([['stub', provider]]), plannerRegistry, {
      prompt: '修复 src/math.js 中的 add 错误并通过 verify',
      explicitFiles: ['src/math.js', 'tests/check-math.js'],
      pastedSnippets: [],
      executeSubtasks: true,
    });

    assert.equal(result.status, 'completed');
    assert.match(await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8'), /return a \+ b;/);
    const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as { outcome: string; message: string };
    const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
    const verifyArtifact = JSON.parse(await readFile(path.join(result.sessionDir, 'subtask.step-3.verify.json'), 'utf8')) as { success: boolean };
    assert.equal(state.outcome, 'DONE');
    assert.match(state.message, /verifier passed|executed all subtasks/i);
    assert.equal(verifyArtifact.success, true);
    assert.match(events, /planner_execution_started/);
    assert.match(events, /"executor":"coder"/);
    assert.match(events, /"modelAlias":"code"/);
    assert.match(events, /subtask_completed/);
    assert.match(events, /planner_execution_finished/);
  });
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

async function testPolicyBlocks(): Promise<void> {
  await withWorkspace(async ({ registry }) => {
    const sensitiveRead = await registry.execute({ name: 'read_file', input: { path: '.env' } });
    assert.equal(sensitiveRead.ok, false);
    assert.match(sensitiveRead.error ?? '', /Sensitive files/);

    const outsideRead = await registry.execute({ name: 'read_file', input: { path: '../outside.txt' } });
    assert.equal(outsideRead.ok, false);
    assert.match(outsideRead.error ?? '', /Read access denied/);

    const blockedShell = await registry.execute({ name: 'run_shell', input: { command: 'curl https://example.com' } });
    assert.equal(blockedShell.ok, false);
    assert.match(blockedShell.error ?? '', /blocked by policy|matched blocked pattern/);
  });
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

  await withCopiedFixture(fileURLToPath(new URL('../examples/verifier-fixture/', import.meta.url)), async ({ workspaceRoot }) => {
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

async function withWorkspace(
  run: (context: {
    tempRoot: string;
    workspaceRoot: string;
    config: AppConfig;
    policy: PolicyEngine;
    registry: ToolRegistry;
  }) => Promise<void>,
): Promise<void> {
  await withCopiedFixture(SUITE_ROOT, run);
}

async function withCopiedFixture(
  fixtureRoot: string,
  run: (context: {
    tempRoot: string;
    workspaceRoot: string;
    config: AppConfig;
    policy: PolicyEngine;
    registry: ToolRegistry;
  }) => Promise<void>,
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
    const registry = new ToolRegistry();
    for (const tool of createBuiltinTools(config, policy)) {
      registry.register(tool);
    }

    await run({ tempRoot, workspaceRoot, config, policy, registry });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

function createAgentConfig(): Record<string, unknown> {
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
    },
    context: {
      maxFiles: 8,
      maxChars: 8000,
      recentFileCount: 2,
      exclude: ['node_modules/**', '.git/**', '.agent/**'],
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

function createPlannerRegistry(config: AppConfig, policy: PolicyEngine): ToolRegistry {
  const registry = new ToolRegistry();
  for (const tool of createPlannerTools(config, policy)) {
    registry.register(tool);
  }
  return registry;
}

async function buildMathFixStep(workspaceRoot: string): Promise<string> {
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

async function buildMultiFileFixStep(workspaceRoot: string): Promise<string> {
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

void main();
