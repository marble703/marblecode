import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppConfig } from '../config/schema.js';
import { watchPlannerSession } from './planner-live.js';
import { applyTuiCommand } from './commands.js';
import { collectPastedSnippet } from './paste.js';
import { renderTuiScreen } from './render.js';
import { executeTuiPrompt } from './run-prompt.js';
import { executeTuiAction } from './session-actions.js';
import { createInitialTuiState, refreshTuiState } from './state.js';

export { createInitialTuiState } from './state.js';

export async function runInteractiveTui(
  configPath: string | undefined,
  initialConfig: AppConfig,
): Promise<void> {
  let rl = readline.createInterface({ input, output });
  let state = await refreshTuiState(configPath, createInitialTuiState(initialConfig.workspaceRoot));

  try {
    while (true) {
      renderTuiScreen(state);
      let line: string;
      try {
        line = await rl.question('tui> ');
      } catch (error) {
        if (error instanceof Error && /readline was closed/i.test(error.message)) {
          break;
        }
        throw error;
      }
      const commandResult = applyTuiCommand(state, line);
      state = await refreshTuiState(configPath, commandResult.state);

      if (commandResult.quit) {
        break;
      }

      if (commandResult.action) {
        try {
          const actionResult = await executeTuiAction(configPath, state, commandResult.action);
          state = await refreshTuiState(configPath, actionResult.state);
          if (actionResult.followSessionDir) {
            rl.close();
            await watchPlannerSession(actionResult.followSessionDir, actionResult.followPollMs ?? 1000);
            rl = readline.createInterface({ input, output });
            state = await refreshTuiState(configPath, {
              ...state,
              lastOutput: `Closed live planner view for ${actionResult.followSessionDir}`,
            });
          }
        } catch (error) {
          state = await refreshTuiState(configPath, {
            ...state,
            lastOutput: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }

      if (commandResult.enterPaste) {
        state = await collectPastedSnippet(rl, state);
        continue;
      }

      if (line.trim().startsWith('/')) {
        continue;
      }

      const prompt = line.trim();
      if (!prompt) {
        state = { ...state, lastOutput: 'Prompt cannot be empty.' };
        continue;
      }

      state = { ...state, lastOutput: `Running ${state.mode} task...` };
      renderTuiScreen(state);

      try {
        state = await refreshTuiState(configPath, await executeTuiPrompt(configPath, initialConfig, state, prompt, rl));
      } catch (error) {
        state = await refreshTuiState(configPath, {
          ...state,
          lastOutput: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    rl.close();
  }
}
