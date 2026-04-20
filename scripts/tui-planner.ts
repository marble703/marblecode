import path from 'node:path';
import readline from 'node:readline';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { resolvePlannerSessionDir } from '../src/session/index.js';
import { loadPlannerView, renderPlannerEvent } from '../src/tui/planner-view.js';

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

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (chunk === 'q' || chunk === '\u0003') {
      cleanupAndExit();
    }
  });

  const timer = setInterval(async () => {
    const view = await loadPlannerView(sessionDir);
    render(view, pollMs);
  }, pollMs);

  const initial = await loadPlannerView(sessionDir);
  render(initial, pollMs);

  function cleanupAndExit(): void {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0, 0);
    readline.clearScreenDown(process.stdout);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.exit(0);
  }
}

function render(view: Awaited<ReturnType<typeof loadPlannerView>>, pollMs: number): void {
  readline.cursorTo(process.stdout, 0, 0);
  readline.clearScreenDown(process.stdout);

  process.stdout.write(`Planner TUI  q=quit  refresh=${pollMs}ms\n\n`);
  process.stdout.write(`Session: ${view.sessionDir}\n`);
  process.stdout.write(`Outcome: ${view.outcome}    Phase: ${view.phase}    Current: ${view.currentStepId ?? '(none)'}\n`);
  process.stdout.write(`Summary: ${view.summary}\n\n`);

  process.stdout.write('Plan Steps\n');
  for (const [index, step] of view.steps.entries()) {
    process.stdout.write(`${index + 1}. [${step.status}] ${step.title} (${step.kind})\n`);
    if (step.relatedFiles.length > 0) {
      process.stdout.write(`   files: ${step.relatedFiles.join(', ')}\n`);
    }
  }

  process.stdout.write('\nSubtasks\n');
  if (view.subtaskEvents.length === 0) {
    process.stdout.write('- none recorded yet\n');
  } else {
    for (const event of view.subtaskEvents.slice(-12)) {
      process.stdout.write(`- ${renderPlannerEvent(event)}\n`);
    }
  }

  process.stdout.write('\nTimeline\n');
  for (const event of view.events.slice(-12)) {
    process.stdout.write(`- ${renderPlannerEvent(event)}\n`);
  }

  process.stdout.write(`\nTerminal: ${view.terminalSummary}\n`);
  if (view.consistencyErrors.length > 0) {
    process.stdout.write(`Consistency: ${view.consistencyErrors.join('; ')}\n`);
  }
}

void main();
