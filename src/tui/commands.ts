import path from 'node:path';
import type { PlannerTarget, TuiCommandResult, TuiMode, TuiState } from './types.js';

export function applyTuiCommand(state: TuiState, line: string): TuiCommandResult {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) {
    return { state, quit: false, enterPaste: false };
  }

  const [command, ...rest] = trimmed.slice(1).split(/\s+/);
  const args = rest.join(' ').trim();
  switch (command) {
    case 'help':
      return {
        state: {
          ...state,
          lastOutput: [
            'Commands:',
            '/mode run|plan|execute',
            '/workspace <path>',
            '/files path1 path2',
            '/add-file path1 path2',
            '/remove-file path1 path2',
            '/clear-files',
            '/paste (enter multiline paste mode, finish with a single . line)',
            '/clear-paste',
            '/verify <command>',
            '/clear-verify',
            '/yes on|off',
            '/sessions',
            '/open <index|session-id-or-path>',
            '/resume [index|session-id-or-path|last]',
            '/replan <extra prompt>   (uses opened or latest planner session)',
            '/follow [index|session-id-or-path|last]',
            '/inspect step <step-id|index>',
            '/open-child <step-id|index>',
            '/show-state',
            '/reset',
            '/quit',
          ].join('\n'),
        },
        quit: false,
        enterPaste: false,
      };
    case 'mode': {
      const mode = args as TuiMode;
      if (mode !== 'run' && mode !== 'plan' && mode !== 'execute') {
        return { state: { ...state, lastOutput: `Unknown mode: ${args}` }, quit: false, enterPaste: false };
      }
      return { state: { ...state, mode, lastOutput: `Mode set to ${mode}` }, quit: false, enterPaste: false };
    }
    case 'workspace': {
      const nextWorkspace = args ? path.resolve(args) : state.workspaceRoot;
      return { state: { ...state, workspaceRoot: nextWorkspace, lastSessionDir: null, plannerView: null, lastOutput: `Workspace set to ${nextWorkspace}` }, quit: false, enterPaste: false };
    }
    case 'files': {
      const files = args.split(/\s+/).filter(Boolean);
      return { state: { ...state, explicitFiles: files, lastOutput: files.length > 0 ? `Files set: ${files.join(', ')}` : 'No files provided.' }, quit: false, enterPaste: false };
    }
    case 'add-file': {
      const files = args.split(/\s+/).filter(Boolean);
      if (files.length === 0) {
        return { state: { ...state, lastOutput: 'No files provided.' }, quit: false, enterPaste: false };
      }

      const explicitFiles = [...new Set([...state.explicitFiles, ...files])];
      return { state: { ...state, explicitFiles, lastOutput: `Files updated: ${explicitFiles.join(', ')}` }, quit: false, enterPaste: false };
    }
    case 'remove-file': {
      const files = args.split(/\s+/).filter(Boolean);
      if (files.length === 0) {
        return { state: { ...state, lastOutput: 'No files provided.' }, quit: false, enterPaste: false };
      }

      const toRemove = new Set(files);
      const explicitFiles = state.explicitFiles.filter((file) => !toRemove.has(file));
      return { state: { ...state, explicitFiles, lastOutput: explicitFiles.length > 0 ? `Files updated: ${explicitFiles.join(', ')}` : 'Files cleared.' }, quit: false, enterPaste: false };
    }
    case 'clear-files':
      return { state: { ...state, explicitFiles: [], lastOutput: 'Files cleared.' }, quit: false, enterPaste: false };
    case 'paste':
      return { state, quit: false, enterPaste: true };
    case 'clear-paste':
      return { state: { ...state, pastedSnippets: [], lastOutput: 'Pasted snippets cleared.' }, quit: false, enterPaste: false };
    case 'verify':
      return { state: { ...state, manualVerifierCommands: args ? [args] : [], lastOutput: args ? `Verifier override set: ${args}` : 'Verifier override cleared.' }, quit: false, enterPaste: false };
    case 'clear-verify':
      return { state: { ...state, manualVerifierCommands: [], lastOutput: 'Verifier override cleared.' }, quit: false, enterPaste: false };
    case 'yes': {
      const normalized = args.toLowerCase();
      const autoApprove = normalized === 'on' || normalized === 'true' || normalized === 'yes';
      return { state: { ...state, autoApprove, lastOutput: `Auto-approve set to ${autoApprove}` }, quit: false, enterPaste: false };
    }
    case 'sessions':
      return { state: { ...state, lastOutput: 'Recent sessions refreshed below.' }, quit: false, enterPaste: false };
    case 'open': {
      const target = args.trim();
      if (!target) {
        return { state: { ...state, lastOutput: 'Provide a session index or path to open.' }, quit: false, enterPaste: false };
      }

      const numericIndex = Number(target);
      const selected = Number.isInteger(numericIndex) && numericIndex > 0
        ? state.recentSessions[numericIndex - 1]?.dir ?? null
        : target;
      if (!selected) {
        return { state: { ...state, lastOutput: `No session found for ${target}` }, quit: false, enterPaste: false };
      }
      return { state: { ...state, lastSessionDir: selected, lastOutput: `Opened session ${selected}` }, quit: false, enterPaste: false };
    }
    case 'resume': {
      if (state.mode === 'run') {
        return { state: { ...state, lastOutput: 'Switch to /mode plan or /mode execute before resuming a planner session.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, args);
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Resuming planner session${formatPlannerTargetLabel(target)}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'resume_planner',
          prompt: '',
          executeSubtasks: state.mode === 'execute',
          ...target,
        },
      };
    }
    case 'replan': {
      if (state.mode === 'run') {
        return { state: { ...state, lastOutput: 'Switch to /mode plan or /mode execute before replanning a planner session.' }, quit: false, enterPaste: false };
      }
      if (!args) {
        return { state: { ...state, lastOutput: 'Provide additional planner input after /replan.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Replanning current planner session with: ${args}` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'resume_planner',
          prompt: args,
          executeSubtasks: state.mode === 'execute',
          ...target,
        },
      };
    }
    case 'follow': {
      const target = resolvePlannerTarget(state, args);
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Opening live planner view${formatPlannerTargetLabel(target)}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'follow_planner',
          pollMs: 1000,
          ...target,
        },
      };
    }
    case 'inspect': {
      const [subcommand, ...inspectRest] = args.split(/\s+/).filter(Boolean);
      if (subcommand !== 'step') {
        return { state: { ...state, lastOutput: 'Use /inspect step <step-id|index>.' }, quit: false, enterPaste: false };
      }
      const stepRef = inspectRest.join(' ').trim();
      if (!stepRef) {
        return { state: { ...state, lastOutput: 'Provide a planner step id or index to inspect.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Inspecting planner step ${stepRef}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'inspect_planner_step',
          stepRef,
          ...target,
        },
      };
    }
    case 'open-child': {
      const stepRef = args.trim();
      if (!stepRef) {
        return { state: { ...state, lastOutput: 'Provide a planner step id or index to open its child session.' }, quit: false, enterPaste: false };
      }

      const target = resolvePlannerTarget(state, '');
      if ('error' in target) {
        return { state: { ...state, lastOutput: target.error }, quit: false, enterPaste: false };
      }

      return {
        state: { ...state, lastOutput: `Opening child session for planner step ${stepRef}...` },
        quit: false,
        enterPaste: false,
        action: {
          type: 'open_child_session',
          stepRef,
          ...target,
        },
      };
    }
    case 'show-state':
      return {
        state: {
          ...state,
          lastOutput: renderTuiStateSummary(state),
        },
        quit: false,
        enterPaste: false,
      };
    case 'reset':
      return {
        state: {
          ...state,
          mode: 'run',
          explicitFiles: [],
          pastedSnippets: [],
          manualVerifierCommands: [],
          autoApprove: false,
          lastSessionDir: null,
          plannerView: null,
          lastOutput: 'TUI state reset.',
        },
        quit: false,
        enterPaste: false,
      };
    case 'quit':
    case 'exit':
      return { state, quit: true, enterPaste: false };
    default:
      return { state: { ...state, lastOutput: `Unknown command: /${command}` }, quit: false, enterPaste: false };
  }
}

export function resolvePlannerTarget(
  state: TuiState,
  rawTarget: string,
): PlannerTarget | { error: string } {
  const target = rawTarget.trim();
  if (!target) {
    if (state.plannerView && state.lastSessionDir) {
      return { sessionRef: state.lastSessionDir };
    }

    const latestPlanner = state.recentSessions.find((session) => session.isPlanner);
    if (latestPlanner) {
      return { sessionRef: latestPlanner.dir };
    }

    return { error: 'No planner session is open. Use /open or /sessions first.' };
  }

  if (target === 'last') {
    return { useLatestSession: true };
  }

  const numericIndex = Number(target);
  if (Number.isInteger(numericIndex) && numericIndex > 0) {
    const session = state.recentSessions[numericIndex - 1];
    if (!session) {
      return { error: `No session found for ${target}` };
    }
    if (!session.isPlanner) {
      return { error: `Session ${target} is not a planner session.` };
    }

    return { sessionRef: session.dir };
  }

  return { sessionRef: target };
}

export function formatPlannerTargetLabel(target: PlannerTarget): string {
  if (target.useLatestSession) {
    return ' (latest planner session)';
  }
  if (target.sessionRef) {
    return ` (${target.sessionRef})`;
  }

  return '';
}

export function renderTuiStateSummary(state: TuiState): string {
  return [
    `mode: ${state.mode}`,
    `workspace: ${state.workspaceRoot}`,
    `explicit files: ${state.explicitFiles.length > 0 ? state.explicitFiles.join(', ') : '(none)'}`,
    `pasted snippets: ${state.pastedSnippets.length}`,
    `verifier override: ${state.manualVerifierCommands[0] ?? '(none)'}`,
    `auto-approve: ${state.autoApprove}`,
    `last session: ${state.lastSessionDir ?? '(none)'}`,
  ].join('\n');
}
