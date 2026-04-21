import path from 'node:path';
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

  process.stdout.write(`Session: ${view.sessionDir}\n`);
  process.stdout.write(`Outcome: ${view.outcome}\n`);
  process.stdout.write(`Phase: ${view.phase}\n`);
  process.stdout.write(`Current step: ${view.currentStepId ?? '(none)'}\n`);
  process.stdout.write(`Active steps: ${view.activeStepIds.join(', ') || '(none)'}\n`);
  process.stdout.write(`Ready steps: ${view.readyStepIds.join(', ') || '(none)'}\n`);
  process.stdout.write(`Failed steps: ${view.failedStepIds.join(', ') || '(none)'}\n`);
  process.stdout.write(`Blocked steps: ${view.blockedStepIds.join(', ') || '(none)'}\n`);
  process.stdout.write(`Summary: ${view.summary}\n\n`);

  process.stdout.write('Plan Steps:\n');
  for (const [index, step] of view.steps.entries()) {
    process.stdout.write(`${index + 1}. [${step.status}] ${step.title} (${step.kind})\n`);
    process.stdout.write(`   attempts: ${step.attempts}${step.executionState ? ` state=${step.executionState}` : ''}\n`);
    if (step.details) {
      process.stdout.write(`   ${step.details}\n`);
    }
    if (step.relatedFiles.length > 0) {
      process.stdout.write(`   files: ${step.relatedFiles.join(', ')}\n`);
    }
    if (step.children.length > 0) {
      process.stdout.write(`   subtasks: ${step.children.join(', ')}\n`);
    }
    if (step.assignee) {
      process.stdout.write(`   assignee: ${step.assignee}\n`);
    }
    if (step.failureKind || step.lastError) {
      process.stdout.write(`   failure: ${step.failureKind ?? 'unknown'}${step.lastError ? ` ${step.lastError}` : ''}\n`);
    }
  }

  process.stdout.write('\nExecution Timeline:\n');
  for (const event of view.events) {
    process.stdout.write(`- ${renderPlannerEvent(event)}\n`);
  }

  process.stdout.write('\nSubtask Results:\n');
  if (view.subtaskEvents.length === 0) {
    const childSteps = view.steps.filter((step) => step.children.length > 0 || step.assignee || step.kind === 'note');
    if (childSteps.length === 0) {
      process.stdout.write('- none recorded yet\n');
    } else {
      for (const step of childSteps) {
        process.stdout.write(`- ${step.id}: waiting on future subtask execution support\n`);
      }
    }
  } else {
    for (const event of view.subtaskEvents) {
      process.stdout.write(`- ${renderPlannerEvent(event)}\n`);
    }
  }

  process.stdout.write('\nPlanner Log Summary:\n');
  process.stdout.write(`- terminal: ${view.terminalSummary}\n`);
  if (view.consistencyErrors.length > 0) {
    process.stdout.write(`- consistency errors: ${view.consistencyErrors.join('; ')}\n`);
  }
}

void main();
