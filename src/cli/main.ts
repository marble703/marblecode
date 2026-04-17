import { parseArgs } from 'node:util';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig } from '../config/load.js';
import { createProviders } from '../provider/index.js';
import { PolicyEngine } from '../policy/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinTools } from '../tools/builtins.js';
import { runAgent } from '../agent/index.js';

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
      yes: {
        type: 'boolean',
        default: false,
      },
    },
  });

  const [command, ...rest] = parsed.positionals;
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
  output.write('Usage: coding-agent run "your request" [--config path] [--file file.ts] [--yes]\n');
}
