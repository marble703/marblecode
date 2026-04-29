export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  stdout?: string;
  stderr?: string;
  error?: string;
  meta?: Record<string, unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

export type ToolProviderKind = 'builtin' | 'external' | 'fixture';

export type ToolProviderAccess = 'read_only' | 'read_write';

export interface ToolProviderMetadata {
  kind?: ToolProviderKind;
  access?: ToolProviderAccess;
  description?: string;
  capabilities?: string[];
}

export interface ToolProviderSummary {
  id: string;
  kind: ToolProviderKind | 'direct';
  access: ToolProviderAccess | 'n/a';
  description: string;
  capabilities: string[];
}

export interface ToolProviderDisposeSummary {
  disposedProviderIds: string[];
}

export interface ToolProvider {
  id: string;
  metadata?: ToolProviderMetadata;
  listTools(): Tool[];
  executeTool(call: ToolCall): Promise<ToolResult>;
  sanitizeLogRecord?(record: Record<string, unknown>): Record<string, unknown>;
  dispose?(): Promise<void> | void;
}
