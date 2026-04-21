import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { runPlanner } from '../src/planner/index.js';
import { createProviders } from '../src/provider/index.js';
import { PolicyEngine } from '../src/policy/index.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { createPlannerTools } from '../src/tools/builtins.js';

const DEFAULT_WORKSPACE = path.resolve('examples/manual-test-suite/project');
const DEFAULT_TASK_DOC = path.resolve('examples/manual-test-suite/planner-task.md');

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      config: {
        type: 'string',
      },
      workspace: {
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
      file: {
        type: 'string',
        multiple: true,
      },
      paste: {
        type: 'string',
        multiple: true,
      },
      session: {
        type: 'string',
      },
      last: {
        type: 'boolean',
        default: false,
      },
    },
  });

  const baseConfig = await loadConfig(parsed.values.config);
  const workspaceRoot = path.resolve(parsed.values.workspace ?? DEFAULT_WORKSPACE);
  const taskDocPath = path.resolve(parsed.values.task ?? DEFAULT_TASK_DOC);
  const prompt = parsed.values.prompt ?? await readPromptFromTaskDoc(taskDocPath);
  const config = {
    ...baseConfig,
    workspaceRoot,
    routing: {
      ...baseConfig.routing,
      ...(parsed.values.model ? { planningModel: parsed.values.model } : {}),
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

  const explicitFiles = parsed.values.file ?? ['src/router.js', 'src/register-routes.js', 'src/server.js', 'tests/router.test.txt'];
  const result = await runPlanner(config, providers, registry, {
    prompt,
    explicitFiles,
    pastedSnippets: parsed.values.paste ?? [],
    ...(parsed.values.session ? { resumeSessionRef: parsed.values.session } : {}),
    ...(parsed.values.last ? { useLatestSession: true } : {}),
  });

  if (result.status !== 'completed') {
    throw new Error(`Planner check did not complete successfully: ${result.status} ${result.message}`);
  }

  const plan = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.json'), 'utf8')) as {
    summary: string;
    steps: Array<{ kind: string; title: string }>;
  };
  const state = JSON.parse(await readFile(path.join(result.sessionDir, 'plan.state.json'), 'utf8')) as {
    outcome: string;
    message: string;
  };
  const events = await readFile(path.join(result.sessionDir, 'plan.events.jsonl'), 'utf8');
  const plannerLog = await readFile(path.join(result.sessionDir, 'planner.log.jsonl'), 'utf8');

  await assertFileAbsent(path.join(result.sessionDir, 'patch.json'));

  if (state.outcome !== 'DONE') {
    throw new Error(`Planner state was not DONE: ${state.outcome} ${state.message}`);
  }
  if (plan.steps.length < 5) {
    throw new Error(`Expected at least 5 planner steps, got ${plan.steps.length}`);
  }
  if (!plan.steps.some((step) => step.kind === 'search' || matchesStepText(step, /查找|梳理|search/i))) {
    throw new Error('Planner output did not include a search step');
  }
  if (!plan.steps.some((step) => step.kind === 'test' || matchesStepText(step, /测试|test/i))) {
    throw new Error('Planner output did not include a test step');
  }
  if (!plan.steps.some((step) => step.kind === 'verify' || matchesStepText(step, /verify|验证/i))) {
    throw new Error('Planner output did not include a verify step');
  }
  if (!events.includes('planner_started') || !events.includes('planner_finished')) {
    throw new Error('Planner events log is missing start/finish entries');
  }
  if (!plannerLog.includes('plan_snapshot') || !plannerLog.includes('planner_terminal')) {
    throw new Error('Planner structured log is missing plan snapshots or terminal summary');
  }

  process.stdout.write(`workspace=${workspaceRoot}\n`);
  process.stdout.write(`session=${result.sessionDir}\n`);
  process.stdout.write(`summary=${JSON.stringify(plan.summary)}\n`);
  process.stdout.write(`steps=${plan.steps.length}\n`);
  process.stdout.write('planner=OK\n');
}

async function readPromptFromTaskDoc(filePath: string): Promise<string> {
  const content = await readFile(filePath, 'utf8');
  const match = content.match(/## Prompt\s+```text\s*([\s\S]*?)\s*```/);
  if (!match?.[1]) {
    throw new Error(`Could not extract prompt from ${filePath}`);
  }

  return match[1].trim();
}

async function assertFileAbsent(filePath: string): Promise<void> {
  try {
    await access(filePath);
    throw new Error(`Planner check wrote unexpected patch artifact: ${filePath}`);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
      return;
    }

    throw error;
  }
}

function matchesStepText(step: { title: string; kind: string; details?: string }, pattern: RegExp): boolean {
  return pattern.test(step.title) || pattern.test(step.kind) || pattern.test(step.details ?? '');
}

void main();
