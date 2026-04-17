import type { Tool, ToolCall, ToolResult } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  public register(tool: Tool): void {
    this.tools.set(tool.definition.name, tool);
  }

  public listDefinitions(): Array<Tool['definition']> {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  public async execute(call: ToolCall): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return {
        ok: false,
        error: `Unknown tool: ${call.name}`,
      };
    }

    return tool.execute(call.input);
  }
}
