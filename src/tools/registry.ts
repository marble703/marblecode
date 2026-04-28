import type { Tool, ToolCall, ToolProvider, ToolResult } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly providerByToolName = new Map<string, ToolProvider>();

  public register(tool: Tool): void {
    this.assertToolNameAvailable(tool.definition.name);
    this.tools.set(tool.definition.name, tool);
  }

  public registerProvider(provider: ToolProvider): void {
    for (const tool of provider.listTools()) {
      this.assertToolNameAvailable(tool.definition.name);
      this.tools.set(tool.definition.name, tool);
      this.providerByToolName.set(tool.definition.name, provider);
    }
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

    const provider = this.providerByToolName.get(call.name);
    if (provider) {
      return provider.executeTool(call);
    }

    return tool.execute(call.input);
  }

  private assertToolNameAvailable(name: string): void {
    if (this.tools.has(name)) {
      throw new Error(`Duplicate tool registration: ${name}`);
    }
  }
}
