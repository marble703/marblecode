import type { Tool, ToolCall, ToolProvider, ToolResult } from './types.js';

export class StaticToolProvider implements ToolProvider {
  public readonly id: string;

  private readonly tools = new Map<string, Tool>();

  public constructor(id: string, tools: Tool[]) {
    this.id = id;
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
