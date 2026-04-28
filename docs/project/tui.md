# TUI Commands

The interactive terminal UI starts with:

```bash
npm run tui
```

Use `--workspace` when launching if you want to target another project:

```bash
node dist/index.js tui --workspace /path/to/project
```

Implementation note: the interactive shell is now split across `src/tui/{commands,paste,state,render,session-actions,run-prompt}.ts`, with `src/tui/agent-repl.ts` kept as the top-level loop.

## Modes

- `/mode run`: start a normal coding task through the agent loop
- `/mode plan`: start or resume a read-only planner session
- `/mode execute`: start or resume a planner session that can execute subtasks and run the verifier

## Workspace And Context

- `/workspace <path>`: switch the active workspace for new commands
- `/files path1 path2`: replace the current explicit file list
- `/add-file path1 path2`: append one or more files to the explicit file list
- `/remove-file path1 path2`: remove one or more files from the explicit file list
- `/clear-files`: clear the explicit file list
- `/paste`: enter multiline paste mode and finish with a single `.` line
- `/clear-paste`: remove all pasted snippets from the current TUI state

Files added with `/files` are also treated as explicit grants for otherwise auto-denied files inside the workspace, and as explicit read-only grants for files outside the workspace.

## Verification And Approval

- `/verify <command>`: set a verifier override for `run` mode
- `/clear-verify`: clear the verifier override
- `/yes on|off`: enable or disable automatic patch approval in `run` mode

## Sessions

- `/sessions`: refresh the recent session list shown in the UI
- `/open <index|session-id-or-path>`: open a session for inspection inside the TUI
- `/resume [index|session-id-or-path|last]`: resume a planner session in the current planner mode
- `/replan <extra prompt>`: replan the currently opened planner session, or the latest planner session if none is open
- `/follow [index|session-id-or-path|last]`: open a live planner viewer for a planner session and press `q` to return to the main TUI
- `/inspect step <step-id|index>`: print step status, related files, the latest recorded subtask event, and available step artifacts for the opened planner session
- `/open-child <step-id|index>`: open the recorded child agent session for a planner step and show its prompt, changed files, and verifier result

Notes:

- `/resume` and `/replan` only work in `/mode plan` or `/mode execute`
- `/open` is view-only; it does not start execution by itself
- `/replan` applies to the currently opened planner session when one is available

## State And Exit

- `/show-state`: print the current mode, workspace, explicit files, pasted snippet count, verifier override, and last session
- `/reset`: reset the TUI state for the current workspace
- `/help`: show the built-in command summary
- `/quit`: exit the TUI

## Typical Workflows

Inspect an existing planner session, then continue it in execute mode:

```text
/mode execute
/sessions
/open 1
/inspect step 2
/open-child 2
/replan keep the current export surface and run verify at the end
```

Follow a planner session that was launched elsewhere:

```text
/follow last
```

Run a normal coding request with explicit files and manual verifier override:

```text
/mode run
/files src/math.ts tests/math.test.ts
/verify npm test
Fix the add function so it returns a + b.
```
