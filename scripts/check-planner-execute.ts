import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { runPlanner } from '../src/planner/index.js';
import { createProviders } from '../src/provider/index.js';
import { PolicyEngine } from '../src/policy/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createPlannerTools } from '../src/tools/builtins.js';

const DEFAULT_FIXTURE = path.resolve('examples/manual-test-suite/project');
const DEFAULT_TASK_DOC = path.resolve('examples/manual-test-suite/planner-exec-task.md');

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      config: {
        type: 'string',
      },
      fixture: {
        type: 'string',
      },
      task: {
        type: 'string',
      },
      prompt: {
        type: 'string',
      },
      model: {
        type: 'string',
      },
      keepWorkspace: {
        type: 'boolean',
        default: true,
      },
    },
  });

  const baseConfig = await loadConfig(parsed.values.config);
  const fixtureRoot = path.resolve(parsed.values.fixture ?? DEFAULT_FIXTURE);
  const taskDocPath = path.resolve(parsed.values.task ?? DEFAULT_TASK_DOC);
  const prompt = parsed.values.prompt ?? await readPromptFromTaskDoc(taskDocPath);

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'marblecode-planner-exec-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  await cp(fixtureRoot, workspaceRoot, { recursive: true });
  await writeFile(path.join(workspaceRoot, 'agent.config.jsonc'), JSON.stringify({}, null, 2), 'utf8');

  const config = {
    ...baseConfig,
    workspaceRoot,
    routing: {
      ...baseConfig.routing,
      planningModel: parsed.values.model ?? baseConfig.routing.defaultModel,
    },
    verifier: {
      ...baseConfig.verifier,
      path: path.join(workspaceRoot, '.marblecode/verifier.md'),
    },
    project: {
      ...baseConfig.project,
      dir: path.join(workspaceRoot, '.marblecode'),
      configPath: path.join(workspaceRoot, '.marblecode/config.jsonc'),
    },
  };

  const providers = createProviders(config);
  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  for (const tool of createPlannerTools(config, policy)) {
    registry.register(tool);
  }

  const result = await runPlanner(config, providers, registry, {
    prompt,
    explicitFiles: ['src/math.js', 'tests/check-math.js', 'package.json'],
    pastedSnippets: [],
    executeSubtasks: true,
  });

  if (result.status !== 'completed') {
    throw new Error(`Planner execute check did not complete: ${result.status} ${result.message}`);
  }

  const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as {
    outcome: string;
    message: string;
  };
  const executionGraph = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.graph.json'), 'utf8')) as {
    waves: Array<{ stepIds: string[] }>;
  };
  const executionLocks = JSON.parse(await readFile(path.join(result.sessionDir, 'execution.locks.json'), 'utf8')) as {
    entries: Array<{ path: string; mode: string }>;
  };
  const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as {
    steps: Array<{ id: string; kind: string; title: string }>;
  };
  const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
  const math = await readFile(path.join(workspaceRoot, 'src/math.js'), 'utf8');
  const verifyStep = plan.steps.find((step) => step.kind === 'verify')
    ?? plan.steps.find((step) => /verify|验证/i.test(step.title));
  if (!verifyStep) {
    throw new Error('Planner execute workflow did not produce a verify step');
  }
  const verify = JSON.parse(await readFile(path.join(result.sessionDir, `subtask.${verifyStep.id}.verify.json`), 'utf8')) as {
    success: boolean;
  };

  if (state.outcome !== 'DONE') {
    throw new Error(`Planner execute state was not DONE: ${state.outcome} ${state.message}`);
  }
  if (!events.includes('subtask_started') || !events.includes('subtask_completed')) {
    throw new Error('Planner execute session did not record subtask execution events');
  }
  if (!events.includes('"executor":"coder"') || !events.includes('"modelAlias":"code"')) {
    throw new Error('Planner execute session did not record coder subtask execution with codeModel');
  }
  if (executionGraph.waves.length === 0) {
    throw new Error('Planner execute session did not record execution waves');
  }
  if (!executionLocks.entries.some((entry) => entry.path === 'src/math.js')) {
    throw new Error('Planner execute session did not record file lock ownership for src/math.js');
  }
  if (!verify.success) {
    throw new Error('Final verifier step was not successful');
  }
  if (!math.includes('return a + b;')) {
    throw new Error('Planner execute workflow did not repair src/math.js');
  }

  process.stdout.write(`workspace=${workspaceRoot}\n`);
  process.stdout.write(`session=${result.sessionDir}\n`);
  process.stdout.write(`message=${JSON.stringify(result.message)}\n`);
  process.stdout.write('planner_execute=OK\n');

  if (!parsed.values.keepWorkspace) {
    process.stdout.write('note=workspace retained by default; remove manually if not needed\n');
  }
}

async function readPromptFromTaskDoc(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  const match = content.match(/## Prompt\s+```text\s*([\s\S]*?)\s*```/);
  if (!match?.[1]) {
    throw new Error(`Could not extract prompt from ${filePath}`);
  }

  return match[1].trim();
}

void main();
