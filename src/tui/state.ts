import path from 'node:path';
import { loadConfig } from '../config/load.js';
import { isPlannerSessionDir } from '../session/index.js';
import { loadPlannerView } from '../planner/view-model.js';
import { listRecentSessions } from './recent-sessions.js';
import type { TuiState } from './types.js';

export function createInitialTuiState(workspaceRoot = process.cwd()): TuiState {
  return {
    mode: 'run',
    workspaceRoot,
    explicitFiles: [],
    pastedSnippets: [],
    manualVerifierCommands: [],
    autoApprove: false,
    lastSessionDir: null,
    lastOutput: 'Type a prompt to start a new task. Use /help for commands.',
    recentSessions: [],
    plannerView: null,
  };
}

export async function refreshTuiState(configPath: string | undefined, state: TuiState): Promise<TuiState> {
  const config = await loadConfig(configPath, state.workspaceRoot);
  const recentSessions = await listRecentSessions(config, 8);
  let plannerView = null;
  if (state.lastSessionDir) {
    const sessionDir = path.isAbsolute(state.lastSessionDir)
      ? state.lastSessionDir
      : path.join(config.workspaceRoot, config.session.dir, state.lastSessionDir);
    if (await isPlannerSessionDir(sessionDir)) {
      try {
        plannerView = await loadPlannerView(sessionDir);
      } catch {
        plannerView = null;
      }
    }
  }

  return {
    ...state,
    recentSessions,
    plannerView,
  };
}
