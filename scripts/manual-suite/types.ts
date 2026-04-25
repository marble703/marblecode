import type { AppConfig } from '../../src/config/schema.js';
import { PolicyEngine } from '../../src/policy/index.js';
import { ToolRegistry } from '../../src/tools/registry.js';

export interface ManualSuiteCase {
  name: string;
  run: () => Promise<void>;
}

export interface WorkspaceContext {
  tempRoot: string;
  workspaceRoot: string;
  config: AppConfig;
  policy: PolicyEngine;
  registry: ToolRegistry;
}
