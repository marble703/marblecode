import readline from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import { loadPlannerView, type PlannerViewModel } from '../planner/view-model.js';
import { renderPlannerEvent } from './planner-view.js';

export async function watchPlannerSession(sessionDir: string, pollMs = 1000): Promise<void> {
  const refreshMs = Math.max(250, pollMs);

  await new Promise<void>((resolve) => {
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const cleanupAndExit = (): void => {
      if (stopped) {
        return;
      }

      stopped = true;
      if (timer) {
        clearInterval(timer);
      }
      input.off('data', handleInput);
      readline.cursorTo(output, 0, 0);
      readline.clearScreenDown(output);
      input.setRawMode?.(false);
      input.pause();
      resolve();
    };

    const renderLatest = async (): Promise<void> => {
      try {
        const view = await loadPlannerView(sessionDir);
        renderPlannerLiveView(view, refreshMs);
      } catch (error) {
        renderPlannerLiveError(sessionDir, refreshMs, error);
      }
    };

    const handleInput = (chunk: string): void => {
      if (chunk === 'q' || chunk === '\u0003') {
        cleanupAndExit();
      }
    };

    input.setRawMode?.(true);
    input.resume();
    input.setEncoding('utf8');
    input.on('data', handleInput);

    timer = setInterval(() => {
      void renderLatest();
    }, refreshMs);

    void renderLatest();
  });
}

export function renderPlannerLiveView(view: PlannerViewModel, pollMs: number): void {
  readline.cursorTo(output, 0, 0);
  readline.clearScreenDown(output);

  output.write(formatPlannerLiveView(view, pollMs));
}

export function formatPlannerLiveView(view: PlannerViewModel, pollMs: number): string {
  const lines: string[] = [];

  lines.push(`Planner TUI  q=quit  refresh=${pollMs}ms`);
  lines.push('');
  lines.push(`Session: ${view.sessionDir}`);
  lines.push(`Schema: ${view.schemaVersion}`);
  lines.push(`Outcome: ${view.outcome}    Phase: ${view.phase}    Current: ${view.currentStepId ?? '(none)'}`);
  lines.push(`Degraded: ${view.degradedCompletion ? 'yes' : 'no'}    Blocked: ${view.blockedReasons.length > 0 ? view.blockedReasons.map((reason) => `${reason.stepId}:${reason.kind}:${reason.blockedByStepId}${reason.conflictDomain ? `(${reason.conflictDomain})` : ''}`).join(', ') : '(none)'}`);
  lines.push(`Latest conflict: ${view.latestConflict ? `${view.latestConflict.fromStepId}->${view.latestConflict.toStepId}(${view.latestConflict.domain ?? view.latestConflict.reason})` : '(none)'}`);
  lines.push(`Current wave: ${view.currentWaveStepIds.join(', ') || '(none)'}    Last completed: ${view.lastCompletedWaveStepIds.join(', ') || '(none)'}`);
  lines.push(`Summary: ${view.summary}`);
  lines.push('');
  lines.push('Plan Steps');
  for (const [index, step] of view.steps.entries()) {
    lines.push(`${index + 1}. [${step.status}] ${step.title} (${step.kind})`);
    if (step.relatedFiles.length > 0) {
      lines.push(`   files: ${step.relatedFiles.join(', ')}`);
    }
  }

  lines.push('');
  lines.push('Subtasks');
  if (view.subtaskEvents.length === 0) {
    lines.push('- none recorded yet');
  } else {
    for (const event of view.subtaskEvents.slice(-12)) {
      lines.push(`- ${renderPlannerEvent(event)}`);
    }
  }

  lines.push('');
  lines.push('Timeline');
  for (const event of view.events.slice(-12)) {
    lines.push(`- ${renderPlannerEvent(event)}`);
  }

  lines.push('');
  lines.push(`Terminal: ${view.terminalSummary}`);
  if (view.consistencyErrors.length > 0) {
    lines.push(`Consistency: ${view.consistencyErrors.join('; ')}`);
  }

  return `${lines.join('\n')}\n`;
}

function renderPlannerLiveError(sessionDir: string, pollMs: number, error: unknown): void {
  readline.cursorTo(output, 0, 0);
  readline.clearScreenDown(output);
  output.write(`Planner TUI  q=quit  refresh=${pollMs}ms\n\n`);
  output.write(`Session: ${sessionDir}\n`);
  output.write(`Unable to load planner view yet: ${error instanceof Error ? error.message : String(error)}\n`);
}
