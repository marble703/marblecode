# Coding Agent Core

Small, secure-by-default coding agent core for local CLI workflows.

## Status

This repository contains the MVP architecture document and an initial TypeScript implementation skeleton that covers:

- CLI entrypoint
- config loading
- provider abstraction with an OpenAI-compatible implementation
- rule-based routing
- context building
- tool registry
- structured patch preview/apply/rollback
- path and shell policy enforcement
- verifier execution
- local session logging with retention cleanup

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Copy and edit the example config:

```bash
cp agent.config.jsonc.example agent.config.jsonc
```

3. Export your API key:

```bash
export OPENAI_API_KEY=your_key_here
```

4. Build the project:

```bash
npm run build
```

5. Run the CLI:

```bash
node dist/index.js run "analyze this repository" --yes
```

## Notes

- Secrets are referenced by environment variable name only.
- Shell execution is restricted to the workspace root and uses a deny-by-default security baseline.
- The agent writes code through structured patch operations, not direct model-controlled file writes.

See `docs/mvp-v1.md` for the MVP contract.
