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
- a local smoke test that proves the patch-driven edit loop works once end to end

## Quick start

1. Install dependencies:

```bash
npm install
```

2. Edit `agent.config.jsonc`:

```bash
nano agent.config.jsonc
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
node dist/index.js run "fix the router fallback logic" --file src/router/index.ts
```

6. Optional: run the local smoke test without any external API.

```bash
npm run smoke:edit
```

## Notes

- Secrets are referenced by environment variable name only.
- Runtime model access uses the OpenAI-compatible `POST /chat/completions` flow.
- Shell execution is restricted to the workspace root and uses a deny-by-default security baseline.
- The agent writes code through structured patch operations, not direct model-controlled file writes.

## Configuration

- Fill the provider base URL in `agent.config.jsonc` at `providers.openai.baseUrl`.
  `http://...` and `https://...` are both accepted in the current MVP so local compatible endpoints can be tested.
- Fill the API key in your shell environment variable named by `providers.openai.apiKeyEnv`.
- If your compatible API uses different model IDs, update `models.cheap.model`, `models.code.model`, and `models.strong.model`.

See `docs/mvp-v1.md` for the MVP contract.
