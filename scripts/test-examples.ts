import { createAgentCases } from './manual-suite/agent.js';
import { createCoreCases } from './manual-suite/core.js';
import { createPlannerCases } from './manual-suite/planner.js';
import { createTuiCases } from './manual-suite/tui.js';
import { createVerifierCases } from './manual-suite/verifier.js';

async function main(): Promise<void> {
  const cases = [
    ...createCoreCases(),
    ...createPlannerCases(),
    ...createTuiCases(),
    ...createAgentCases(),
    ...createVerifierCases(),
  ];

  let completed = 0;
  for (const testCase of cases) {
    process.stdout.write(`case:start ${testCase.name}\n`);
    await testCase.run();
    completed += 1;
    process.stdout.write(`case:ok ${testCase.name}\n`);
  }

  process.stdout.write(`manual example suite ok (${completed} cases)\n`);
}

void main();
