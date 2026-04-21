import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config/load.js';
import { createProviders } from '../provider/index.js';
import { PolicyEngine } from '../policy/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools, createPlannerTools } from '../tools/builtins.js';
import { runAgent } from '../agent/index.js';
import { runPlanner } from '../planner/index.js';
import { tryRollback } from '../agent/index.js';
import { runInteractiveTui } from '../tui/agent-repl.js';
import { resolveSessionDir } from '../session/index.js';

export async function main(): Promise<void> {
  const parsed = parseArgs({
    allowPositionals: true,
    options: {
      config: {
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
      verify: {
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
      yes: {
        type: 'boolean',
        default: false,
      },
      execute: {
        type: 'boolean',
        default: false,
      },
      workspace: {
        type: 'string',
      },
    },
  });

  const [command, ...rest] = parsed.positionals;
  if (command === 'rollback') {
    await rollbackCommand(parsed.values.config, parsed.values.workspace, parsed.values.session, parsed.values.last);
    return;
  }

  if (command === 'plan') {
    await planCommand(parsed.values.config, parsed.values.workspace, rest.join(' ').trim(), parsed.values.file ?? [], parsed.values.paste ?? [], parsed.values.session, parsed.values.last, parsed.values.execute);
    return;
  }

  if (command === 'tui') {
    await tuiCommand(parsed.values.config, parsed.values.workspace);
    return;
  }

  if (command !== 'run') {
    printUsage();
    process.exitCode = 1;
    return;
  }

  const prompt = rest.join(' ').trim();
  if (!prompt) {
    throw new Error('A prompt is required. Example: coding-agent run "fix failing tests"');
  }

  const config = await loadConfig(parsed.values.config, parsed.values.workspace);
  const providers = createProviders(config);
  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  for (const tool of createBuiltinTools(config, policy)) {
    registry.register(tool);
  }

  const result = await runAgent(config, providers, registry, {
    prompt,
    explicitFiles: parsed.values.file ?? [],
    pastedSnippets: parsed.values.paste ?? [],
    manualVerifierCommands: parsed.values.verify ?? [],
    autoApprove: parsed.values.yes,
    confirm: confirmPatch,
  });

  output.write(`${result.status}: ${result.message}\n`);
  output.write(`session: ${result.sessionDir}\n`);
  if (result.changedFiles.length > 0) {
    output.write(`changed: ${result.changedFiles.join(', ')}\n`);
  }
}

async function confirmPatch(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    output.write(`${message}\n`);
    const answer = await rl.question('Apply patch? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
}

function printUsage(): void {
  output.write('Usage: coding-agent run "your request" [--config path] [--workspace path] [--file file.ts] [--paste "code"] [--verify "npm run build"] [--yes]\n');
  output.write('   or: coding-agent plan "your request" [--config path] [--workspace path] [--file file.ts] [--paste "code"] [--execute] [--session session-id-or-path | --last]\n');
  output.write('   or: coding-agent tui [--config path] [--workspace path]\n');
  output.write('   or: coding-agent rollback [--config path] [--workspace path] [--session session-id-or-path | --last]\n');
}

async function tuiCommand(configPath: string | undefined, workspacePath: string | undefined): Promise<void> {
  const config = await loadConfig(configPath, workspacePath);
  await runInteractiveTui(configPath, config);
}

async function planCommand(
  configPath: string | undefined,
  workspacePath: string | undefined,
  prompt: string,
  explicitFiles: string[],
  pastedSnippets: string[],
  sessionRef: string | undefined,
  useLatest: boolean,
  execute: boolean,
): Promise<void> {
  if (!prompt && !sessionRef && !useLatest) {
    throw new Error('A prompt is required for a new plan. Use --session/--last to resume an existing planner session.');
  }

  const config = await loadConfig(configPath, workspacePath);
  const providers = createProviders(config);
  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  for (const tool of createPlannerTools(config, policy)) {
    registry.register(tool);
  }

  const result = await runPlanner(config, providers, registry, {
    prompt,
    explicitFiles,
    pastedSnippets,
    ...(execute ? { executeSubtasks: true } : {}),
    ...(sessionRef ? { resumeSessionRef: sessionRef } : {}),
    ...(useLatest ? { useLatestSession: true } : {}),
  });

  output.write(`${result.status}: ${result.message}\n`);
  output.write(`session: ${result.sessionDir}\n`);
}

async function rollbackCommand(configPath: string | undefined, workspacePath: string | undefined, sessionRef: string | undefined, useLatest: boolean): Promise<void> {
  const config = await loadConfig(configPath, workspacePath);
  const sessionDir = await resolveSessionDir(config, sessionRef, useLatest);
  const rollback = JSON.parse(await readFile(`${sessionDir}/rollback.json`, 'utf8')) as Parameters<typeof tryRollback>[1];
  await tryRollback(config, rollback);
  output.write(`rolled back: ${sessionDir}\n`);
}
