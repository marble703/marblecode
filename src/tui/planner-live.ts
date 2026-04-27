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

  output.write(`Planner TUI  q=quit  refresh=${pollMs}ms\n\n`);
  output.write(`Session: ${view.sessionDir}\n`);
  output.write(`Outcome: ${view.outcome}    Phase: ${view.phase}    Current: ${view.currentStepId ?? '(none)'}\n`);
  output.write(`Summary: ${view.summary}\n\n`);

  output.write('Plan Steps\n');
  for (const [index, step] of view.steps.entries()) {
    output.write(`${index + 1}. [${step.status}] ${step.title} (${step.kind})\n`);
    if (step.relatedFiles.length > 0) {
      output.write(`   files: ${step.relatedFiles.join(', ')}\n`);
    }
  }

  output.write('\nSubtasks\n');
  if (view.subtaskEvents.length === 0) {
    output.write('- none recorded yet\n');
  } else {
    for (const event of view.subtaskEvents.slice(-12)) {
      output.write(`- ${renderPlannerEvent(event)}\n`);
    }
  }

  output.write('\nTimeline\n');
  for (const event of view.events.slice(-12)) {
    output.write(`- ${renderPlannerEvent(event)}\n`);
  }

  output.write(`\nTerminal: ${view.terminalSummary}\n`);
  if (view.consistencyErrors.length > 0) {
    output.write(`Consistency: ${view.consistencyErrors.join('; ')}\n`);
  }
}

function renderPlannerLiveError(sessionDir: string, pollMs: number, error: unknown): void {
  readline.cursorTo(output, 0, 0);
  readline.clearScreenDown(output);
  output.write(`Planner TUI  q=quit  refresh=${pollMs}ms\n\n`);
  output.write(`Session: ${sessionDir}\n`);
  output.write(`Unable to load planner view yet: ${error instanceof Error ? error.message : String(error)}\n`);
}
