# MVP v1 Architecture

## Goal

Build a small, stable coding agent core for local CLI-based development workflows. The MVP prioritizes correctness, safety, and extensibility over feature breadth.

## Non-goals

- multi-agent orchestration
- vector index or embeddings
- GUI
- autonomous network access outside configured model providers
- direct model-driven file writes

## Fixed decisions

- runtime: `Node.js 20+`
- language: `TypeScript`
- interface: local `CLI`
- config: `agent.config.jsonc`
- secrets: environment variables only via `apiKeyEnv`
- routing: static rule-based
- execution: single agent with explicit step cap, `max_steps=8`
- edit protocol: model outputs structured patch operations only
- patch confirmation: manual by default, skippable with `--yes`
- verifier failure semantics: task remains incomplete and may trigger bounded repair loops
- shell and logging defaults: secure by default

## Module boundaries

### `provider`

Unified model interface. The internal request and response types must already reserve fields for:

- system prompt mapping differences
- streaming
- tool calling
- chunked responses
- reasoning token accounting
- vendor-specific metadata

MVP implementation: `OpenAICompatibleProvider` only, using the traditional `POST /chat/completions` interface.

### `router`

Maps a user task to a model profile and execution policy.

MVP task classes:

- question: low-cost model
- code change: code model
- planning/design: strong model

### `context`

Collects bounded code context from:

- user-explicit files
- recent files
- optional git diff
- text search results

Every context item carries:

- `path`
- `reason`
- `source`
- `excerpt`
- `score`
- `sensitivity`
- optional `warning`

Sensitive files are excluded by default. If the user explicitly requests one, it can be read in a read-only path with a visible warning.

### `tools`

Uniform tool registry with policy checks before execution.

MVP tools:

- `read_file`
- `list_files`
- `search_text`
- `run_shell`
- `git_diff`

No direct `write_file` tool is exposed to the model.

### `patch`

System-internal standard patch representation. Models do not write files directly. They emit structured edit intentions that are converted to the patch format and then applied by the host.

Patch operations contain at least:

- target file path
- modification type
- diff summary
- exact content payload needed for application

The host generates rollback metadata during apply.

### `policy`

Mandatory policy checks for every file and tool operation.

MVP scope:

- path-based access control
- shell command restrictions
- environment variable allowlist
- provider host allowlist
- no external tool networking

### `verifier`

Runs configured validation commands after patch application.

Verifier failure is not a generic text error. It is structured feedback with:

- exit code
- stdout
- stderr
- failed stage
- retryability

The task is considered incomplete while verification fails.

### `session`

Persists request metadata, context selection, tool activity, patch artifacts, and verification output locally. Retention is controlled by both age and count.

## Execution loop

1. Parse CLI input and load config.
2. Create a session and clean old sessions.
3. Route the task to a model profile.
4. Build bounded context.
5. Run the agent loop with `max_steps`.
6. Each step contains thought, tool call, or patch proposal.
7. If a patch is proposed, preview it and request confirmation unless `--yes` is set.
8. Apply patch and record rollback info.
9. Run verifier.
10. If verifier fails and repair attempts remain, feed structured failure back into the next loop.
11. Stop when complete, when limits are hit, or when user intervention is required.

## Step protocol

The MVP does not depend on provider-native tool calling. Instead, the agent protocol is JSON-based so it works uniformly across providers.

Valid model step outputs:

- `tool_call`
- `patch`
- `final`

Example shape:

```json
{
  "type": "tool_call",
  "thought": "Read the router implementation before editing.",
  "tool": "read_file",
  "input": {
    "path": "src/router/index.ts"
  }
}
```

```json
{
  "type": "patch",
  "thought": "Implement the missing route fallback.",
  "patch": {
    "version": "1",
    "summary": "Add a fallback route for design-oriented requests.",
    "operations": [
      {
        "type": "replace_file",
        "path": "src/router/index.ts",
        "diff": "Add a fallback branch for planning prompts.",
        "newText": "..."
      }
    ]
  }
}
```

## Security baseline

### Secrets

- config stores `apiKeyEnv`, never raw API keys
- CLI flags must not accept raw secrets
- logs redact known secret fields and authorization headers

### Context safety

- sensitive files are fully excluded by default
- explicit sensitive file access is read-only and warns clearly

### Shell safety

- shell runs only in the current workspace
- no full environment inheritance by default
- explicit env allowlist only
- deny `sudo`
- deny destructive root-level patterns such as `rm -rf /`
- deny network commands in MVP
- deny background persistent processes
- enforce timeout and output limits

### Provider safety

- base URL must be `http` or `https`
- provider host must be on an allowlist
- tool networking remains disabled even though provider calls are allowed

## Acceptance criteria

- can load config and validate provider/policy defaults
- can route a task and build bounded context
- can execute safe read/search/list/shell/git tools
- can parse, preview, apply, and rollback structured patches
- can run verifier commands and return structured failures
- can persist session artifacts locally and clean them by age and count
- can complete one local smoke-tested patch-driven code edit loop

## Deferred items

- native tool calling adapters per provider
- streaming output UI
- command approval workflows
- encrypted local session storage
- remote memory and skills
