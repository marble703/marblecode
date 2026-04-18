# Marblecode Verifier Plan

Project verification lives in `.marblecode/verifier.md` so it can be versioned with the repo.

## TypeScript Build

- run: npm run build
- when: Default blocking verification for normal source changes.

## Patch Smoke

- run: npm run smoke:edit
- paths: src/agent/**, src/patch/**, src/session/**, scripts/smoke-edit.ts
- platforms: linux, darwin
- when: Re-run the no-network patch smoke test when the patch/session loop changes.

## Verifier Smoke

- run: npm run smoke:verifier
- paths: src/verifier/**, src/config/**, scripts/smoke-verifier.ts, examples/verifier-fixture/**, .marblecode/**
- platforms: linux, darwin
- when: Re-run the verifier smoke when project verifier logic or config changes.
