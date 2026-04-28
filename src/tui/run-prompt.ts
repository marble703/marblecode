import type { Interface } from 'node:readline/promises';
import type { AppConfig } from '../config/schema.js';
import { loadConfig } from '../config/load.js';
import { runAgent } from '../agent/index.js';
import { runPlanner } from '../planner/index.js';
import { PolicyEngine } from '../policy/index.js';
import { createProviders } from '../provider/index.js';
import { ToolRegistry } from '../tools/registry.js';
import { createBuiltinToolProvider, createPlannerToolProvider } from '../tools/builtins.js';
import { loadPlannerView } from '../planner/view-model.js';
import { formatPlannerView } from './planner-view.js';
import { confirmPatchInTui } from './paste.js';
import type { TuiState } from './types.js';

export async function executeTuiPrompt(
  configPath: string | undefined,
  initialConfig: AppConfig,
  state: TuiState,
  prompt: string,
  rl: Interface,
): Promise<TuiState> {
  const config = await loadConfig(configPath, state.workspaceRoot);
  const providers = createProviders(config);
  if (state.mode === 'run') {
    const policy = new PolicyEngine(config);
    const registry = new ToolRegistry();
    registry.registerProvider(createBuiltinToolProvider(config, policy));
    const result = await runAgent(config, providers, registry, {
      prompt,
      explicitFiles: state.explicitFiles,
      pastedSnippets: state.pastedSnippets,
      manualVerifierCommands: state.manualVerifierCommands,
      autoApprove: state.autoApprove,
      confirm: async (message) => confirmPatchInTui(rl, message),
    });
    return {
      ...state,
      lastSessionDir: result.sessionDir,
      lastOutput: [
        `${result.status}: ${result.message}`,
        `model: ${result.modelAlias}`,
        `session: ${result.sessionDir}`,
        result.changedFiles.length > 0 ? `changed: ${result.changedFiles.join(', ')}` : 'changed: (none)',
      ].join('\n'),
    };
  }

  void initialConfig;
  const policy = new PolicyEngine(config);
  const registry = new ToolRegistry();
  registry.registerProvider(createPlannerToolProvider(config, policy));
  const result = await runPlanner(config, providers, registry, {
    prompt,
    explicitFiles: state.explicitFiles,
    pastedSnippets: state.pastedSnippets,
    ...(state.mode === 'execute' ? { executeSubtasks: true } : {}),
  });

  let plannerSummary = `${result.status}: ${result.message}\nsession: ${result.sessionDir}`;
  try {
    const view = await loadPlannerView(result.sessionDir);
    plannerSummary = formatPlannerView(view);
  } catch {
    plannerSummary = `${plannerSummary}\n(no planner summary available)`;
  }

  return {
    ...state,
    lastSessionDir: result.sessionDir,
    plannerView: null,
    lastOutput: plannerSummary,
  };
}
