import { stdout as output } from 'node:process';
import type { SessionListItem } from '../session/index.js';
import { formatPlannerView } from './planner-view.js';
import type { TuiState } from './types.js';

export function renderTuiScreen(state: TuiState): void {
  output.write('\u001bc');
  output.write('Coding Agent TUI\n');
  output.write(`mode=${state.mode} workspace=${state.workspaceRoot} autoApprove=${state.autoApprove} files=${state.explicitFiles.length} pasted=${state.pastedSnippets.length} verify=${state.manualVerifierCommands.length > 0 ? 'on' : 'off'}\n`);
  output.write(`lastSession=${state.lastSessionDir ?? '(none)'}\n\n`);
  output.write(`${state.lastOutput}\n\n`);
  output.write('Recent Sessions\n');
  if (state.recentSessions.length === 0) {
    output.write('- none\n');
  } else {
    for (const [index, session] of state.recentSessions.entries()) {
      output.write(`${index + 1}. ${session.id} ${formatSessionBadge(session)}\n`);
      output.write(`   ${session.summary}\n`);
    }
  }

  if (state.plannerView) {
    output.write('\nPlanner Panel\n');
    output.write(`${formatPlannerView(state.plannerView)}\n\n`);
  }

  output.write('Tips: type a prompt to run it, /help for commands.\n');
}

function formatSessionBadge(session: SessionListItem): string {
  if (!session.isPlanner) {
    return '(child)';
  }

  const fragments = [session.outcome ?? 'planner', session.phase ?? 'unknown'];
  if ('currentStepId' in session && session.currentStepId) {
    fragments.push(`step=${session.currentStepId}`);
  }
  return `(planner ${fragments.join(' ')})`;
}
