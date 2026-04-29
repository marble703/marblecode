import type { Tool, ToolCall, ToolProvider, ToolResult } from './types.js';

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly providerByToolName = new Map<string, ToolProvider>();
  private readonly providersById = new Map<string, ToolProvider>();
  private readonly providerRegistrationOrder: ToolProvider[] = [];

  public register(tool: Tool): void {
    this.assertToolNameAvailable(tool.definition.name);
    this.tools.set(tool.definition.name, tool);
  }

  public registerProvider(provider: ToolProvider): void {
    this.assertProviderIdAvailable(provider.id);
    for (const tool of provider.listTools()) {
      this.assertToolNameAvailable(tool.definition.name);
      this.tools.set(tool.definition.name, tool);
      this.providerByToolName.set(tool.definition.name, provider);
    }
    this.providersById.set(provider.id, provider);
    this.providerRegistrationOrder.push(provider);
  }

  public listDefinitions(): Array<Tool['definition']> {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  public listProviders(): ToolProvider[] {
    return [...this.providerRegistrationOrder];
  }

  public getProviderForTool(name: string): ToolProvider | null {
    return this.providerByToolName.get(name) ?? null;
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

  public async disposeAll(): Promise<void> {
    const failures: string[] = [];
    const disposed = new Set<string>();
    for (const provider of this.providerRegistrationOrder) {
      if (disposed.has(provider.id)) {
        continue;
      }
      disposed.add(provider.id);
      if (!provider.dispose) {
        continue;
      }
      try {
        await provider.dispose();
      } catch (error) {
        failures.push(`${provider.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Failed to dispose tool providers: ${failures.join('; ')}`);
    }
  }

  private assertToolNameAvailable(name: string): void {
    if (this.tools.has(name)) {
      throw new Error(`Duplicate tool registration: ${name}`);
    }
  }

  private assertProviderIdAvailable(id: string): void {
    if (this.providersById.has(id)) {
      throw new Error(`Duplicate tool provider registration: ${id}`);
    }
  }
}
