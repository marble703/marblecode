import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { resolvePlannerSessionDir } from '../src/session/index.js';
import { watchPlannerSession } from '../src/tui/planner-live.js';

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      config: {
        type: 'string',
      },
      session: {
        type: 'string',
      },
      last: {
        type: 'boolean',
        default: false,
      },
      workspace: {
        type: 'string',
      },
      pollMs: {
        type: 'string',
      },
    },
  });

  const baseConfig = await loadConfig(parsed.values.config);
  const workspaceRoot = parsed.values.workspace ? path.resolve(parsed.values.workspace) : baseConfig.workspaceRoot;
  const config = {
    ...baseConfig,
    workspaceRoot,
    project: {
      ...baseConfig.project,
      dir: path.join(workspaceRoot, '.marblecode'),
      configPath: baseConfig.project.configPath ? path.join(workspaceRoot, '.marblecode/config.jsonc') : null,
    },
  };
  const sessionDir = await resolvePlannerSessionDir(config, parsed.values.session, parsed.values.last);
  const pollMs = Math.max(250, Number(parsed.values.pollMs ?? '1000'));

  await watchPlannerSession(sessionDir, pollMs);
}

void main();
