import type { ManualSuiteCase } from './types.js';
import { createPlannerExecutionCases } from './planner-execution.js';
import { createPlannerGraphCases } from './planner-graph.js';
import { createPlannerRecoveryCases } from './planner-recovery.js';
import { createPlannerRuntimeCases } from './planner-runtime.js';

export function createPlannerCases(): ManualSuiteCase[] {
  return [
    ...createPlannerGraphCases(),
    ...createPlannerRuntimeCases(),
    ...createPlannerExecutionCases(),
    ...createPlannerRecoveryCases(),
  ];
}
