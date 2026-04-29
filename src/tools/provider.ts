import type { Tool, ToolCall, ToolProvider, ToolProviderMetadata, ToolResult } from './types.js';

export class StaticToolProvider implements ToolProvider {
  public readonly id: string;
  public readonly metadata: ToolProviderMetadata;
  public sanitizeLogRecord?: (record: Record<string, unknown>) => Record<string, unknown>;

  private readonly tools = new Map<string, Tool>();

  public constructor(id: string, tools: Tool[], metadata?: ToolProviderMetadata) {
    this.id = id;
    this.metadata = {
      kind: metadata?.kind ?? 'builtin',
      access: metadata?.access ?? 'read_write',
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(metadata?.capabilities ? { capabilities: metadata.capabilities } : {}),
    };
    for (const tool of tools) {
      this.tools.set(tool.definition.name, tool);
    }
  }

  public listTools(): Tool[] {
    return [...this.tools.values()];
  }

  public async executeTool(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool from provider ${this.id}: ${call.name}`,
      };
    }

    return tool.execute(call.input);
  }
}
