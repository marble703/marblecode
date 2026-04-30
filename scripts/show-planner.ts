import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { resolvePlannerSessionDir } from '../src/session/index.js';
import { formatPlannerView, loadPlannerView } from '../src/tui/planner-view.js';

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
  const view = await loadPlannerView(sessionDir);
  process.stdout.write(`${formatPlannerView(view)}\n`);
}

void main();
