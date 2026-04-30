import type { ManualSuiteCase } from './types.js';
import { createPlannerRuntimeCoreCases } from './planner-runtime-core.js';
import { createPlannerRuntimeResumeCases } from './planner-runtime-resume.js';

export function createPlannerRuntimeCases(): ManualSuiteCase[] {
  return [
    ...createPlannerRuntimeCoreCases(),
    ...createPlannerRuntimeResumeCases(),
  ];
}
