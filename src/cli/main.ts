import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '../config/load.js';
import { createProviders } from '../provider/index.js';
import { PolicyEngine } from '../policy/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools } from '../tools/builtins.js';
import { runAgent } from '../agent/index.js';
import { tryRollback } from '../agent/index.js';
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
    },
  });

  const [command, ...rest] = parsed.positionals;
  if (command === 'rollback') {
    await rollbackCommand(parsed.values.config, parsed.values.session, parsed.values.last);
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

  const config = await loadConfig(parsed.values.config);
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
  output.write('Usage: coding-agent run "your request" [--config path] [--file file.ts] [--paste "code"] [--verify "npm run build"] [--yes]\n');
  output.write('   or: coding-agent rollback [--config path] [--session session-id-or-path | --last]\n');
}

async function rollbackCommand(configPath: string | undefined, sessionRef: string | undefined, useLatest: boolean): Promise<void> {
  const config = await loadConfig(configPath);
  const sessionDir = await resolveSessionDir(config, sessionRef, useLatest);
  const rollback = JSON.parse(await readFile(`${sessionDir}/rollback.json`, 'utf8')) as Parameters<typeof tryRollback>[1];
  await tryRollback(config, rollback);
  output.write(`rolled back: ${sessionDir}\n`);
}
