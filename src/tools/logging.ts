import type { ToolProviderSummary, ToolResult } from './types.js';

export type ToolLogMode = 'agent' | 'planner';

export interface ToolLogRecordInput {
  mode: ToolLogMode;
  tool: string;
  input: Record<string, unknown>;
  result: ToolResult;
  providerSummary: ToolProviderSummary;
  logToolBodies: boolean;
}

const CAPABILITY_SOURCE_FIELDS = {
  diagnostics: 'diagnosticsSource',
  symbols: 'symbolsSource',
  references: 'referencesSource',
} satisfies Record<string, string>;

export function buildToolLogRecord(input: ToolLogRecordInput): Record<string, unknown> {
  const record: Record<string, unknown> = {
    mode: input.mode,
    tool: input.tool,
    providerId: input.providerSummary.id,
    providerKind: input.providerSummary.kind,
    providerAccess: input.providerSummary.access,
    providerCapabilities: input.providerSummary.capabilities,
    input: input.logToolBodies ? input.input : '[omitted]',
    result: input.logToolBodies ? input.result : { ok: input.result.ok },
  };

  for (const [capability, sourceField] of Object.entries(CAPABILITY_SOURCE_FIELDS)) {
    record[sourceField] = input.providerSummary.capabilities.includes(capability)
      ? input.providerSummary.id
      : '';
  }

  return record;
}
