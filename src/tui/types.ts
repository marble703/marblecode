import type { PlannerViewModel } from '../planner/view-model.js';
import type { SessionListItem } from '../session/index.js';

export type TuiMode = 'run' | 'plan' | 'execute';

export interface TuiState {
  mode: TuiMode;
  workspaceRoot: string;
  explicitFiles: string[];
  pastedSnippets: string[];
  manualVerifierCommands: string[];
  autoApprove: boolean;
  lastSessionDir: string | null;
  lastOutput: string;
  recentSessions: SessionListItem[];
  plannerView: PlannerViewModel | null;
}

export interface TuiCommandResult {
  state: TuiState;
  quit: boolean;
  enterPaste: boolean;
  action?: TuiAction;
}

export type TuiAction =
  | ({
      type: 'resume_planner';
      prompt: string;
      executeSubtasks: boolean;
    } & PlannerTarget)
  | ({
      type: 'follow_planner';
      pollMs: number;
    } & PlannerTarget)
  | ({
      type: 'inspect_planner_step';
      stepRef: string;
    } & PlannerTarget)
  | ({
      type: 'open_child_session';
      stepRef: string;
    } & PlannerTarget);

export interface PlannerTarget {
  sessionRef?: string;
  useLatestSession?: boolean;
}
