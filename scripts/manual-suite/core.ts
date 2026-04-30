import type { ManualSuiteCase } from './types.js';
import { createCoreLocalProviderCases } from './core-local-providers.js';
import { createCoreProviderCases } from './core-providers.js';
import { createCoreToolCases } from './core-tools.js';

export function createCoreCases(): ManualSuiteCase[] {
  return [
    ...createCoreToolCases(),
    ...createCoreProviderCases(),
    ...createCoreLocalProviderCases(),
  ];
}
