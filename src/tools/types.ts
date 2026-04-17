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
