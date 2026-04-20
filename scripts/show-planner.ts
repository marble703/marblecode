import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { resolveSessionDir } from '../src/session/index.js';

interface PlannerEventRecord {
  type?: string;
  [key: string]: unknown;
}

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

  const sessionDir = await resolveSessionDir(config, parsed.values.session, parsed.values.last);
  const [planRaw, stateRaw, eventsRaw, plannerLogRaw] = await Promise.all([
    readFile(path.join(sessionDir, 'plan.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.state.json'), 'utf8'),
    readFile(path.join(sessionDir, 'plan.events.jsonl'), 'utf8'),
    readFile(path.join(sessionDir, 'planner.log.jsonl'), 'utf8'),
  ]);

  const plan = JSON.parse(planRaw) as {
    revision: number;
    summary: string;
    steps: Array<{
      id: string;
      title: string;
      status: string;
      kind: string;
      details?: string;
      relatedFiles?: string[];
      children: string[];
      assignee?: string;
    }>;
  };
  const state = JSON.parse(stateRaw) as {
    phase: string;
    outcome: string;
    message: string;
    currentStepId: string | null;
    consistencyErrors: string[];
  };
  const events = parseJsonLines(eventsRaw);
  const plannerLog = parseJsonLines(plannerLogRaw);

  process.stdout.write(`Session: ${sessionDir}\n`);
  process.stdout.write(`Outcome: ${state.outcome}\n`);
  process.stdout.write(`Phase: ${state.phase}\n`);
  process.stdout.write(`Current step: ${state.currentStepId ?? '(none)'}\n`);
  process.stdout.write(`Summary: ${plan.summary || state.message}\n\n`);

  process.stdout.write('Plan Steps:\n');
  for (const [index, step] of plan.steps.entries()) {
    process.stdout.write(`${index + 1}. [${step.status}] ${step.title} (${step.kind})\n`);
    if (step.details) {
      process.stdout.write(`   ${step.details}\n`);
    }
    if (step.relatedFiles && step.relatedFiles.length > 0) {
      process.stdout.write(`   files: ${step.relatedFiles.join(', ')}\n`);
    }
    if (step.children.length > 0) {
      process.stdout.write(`   subtasks: ${step.children.join(', ')}\n`);
    }
    if (step.assignee) {
      process.stdout.write(`   assignee: ${step.assignee}\n`);
    }
  }

  process.stdout.write('\nExecution Timeline:\n');
  for (const event of events) {
    process.stdout.write(`- ${renderEvent(event)}\n`);
  }

  const subtaskEvents = events.filter((event) => String(event.type ?? '').startsWith('subtask'));
  process.stdout.write('\nSubtask Results:\n');
  if (subtaskEvents.length === 0) {
    const childSteps = plan.steps.filter((step) => step.children.length > 0 || step.assignee || step.kind === 'note');
    if (childSteps.length === 0) {
      process.stdout.write('- none recorded yet\n');
    } else {
      for (const step of childSteps) {
        process.stdout.write(`- ${step.id}: waiting on future subtask execution support\n`);
      }
    }
  } else {
    for (const event of subtaskEvents) {
      process.stdout.write(`- ${renderEvent(event)}\n`);
    }
  }

  const terminal = plannerLog.findLast((entry) => entry.type === 'planner_terminal');
  process.stdout.write('\nPlanner Log Summary:\n');
  if (terminal) {
    process.stdout.write(`- terminal: ${String(terminal.outcome ?? '')} ${String(terminal.message ?? '')}\n`);
  } else {
    process.stdout.write('- terminal: unavailable\n');
  }
  if (state.consistencyErrors.length > 0) {
    process.stdout.write(`- consistency errors: ${state.consistencyErrors.join('; ')}\n`);
  }
}

function parseJsonLines(content: string): PlannerEventRecord[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PlannerEventRecord);
}

function renderEvent(event: PlannerEventRecord): string {
  const type = String(event.type ?? 'event');
  if (type === 'plan_set') {
    return `plan set (revision ${String(event.revision ?? '')}, ${String(event.stepCount ?? '')} steps)`;
  }
  if (type === 'plan_step_updated') {
    return `${String(event.stepId ?? '')} -> ${String(event.status ?? '')}${event.message ? ` (${String(event.message)})` : ''}`;
  }
  if (type === 'tool_result') {
    return `tool ${String(event.tool ?? '')}: ${String(event.ok ?? '')}`;
  }
  if (type === 'planner_invalid_output') {
    return `invalid output retry ${String(event.attempt ?? '')}/${String(event.maxAttempts ?? '')}: ${String(event.error ?? '')}`;
  }
  if (type === 'planner_finished') {
    return `finished ${String(event.outcome ?? '')}: ${String(event.message ?? '')}`;
  }
  if (type === 'planner_failed') {
    return `failed: ${String(event.reason ?? '')}`;
  }
  if (type === 'planner_started' || type === 'planner_resumed' || type === 'planner_replanned') {
    return `${type}: ${String(event.prompt ?? '')}`;
  }
  return `${type}: ${JSON.stringify(event)}`;
}

void main();
