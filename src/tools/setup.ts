import type { AppConfig } from '../config/schema.js';
import { PolicyEngine } from '../policy/index.js';
import { createBuiltinToolProvider, createPlannerToolProvider } from './builtins.js';
import { ToolRegistry } from './registry.js';
import type { ToolProvider, ToolProviderSummary } from './types.js';

export function assertExternalToolProviderAllowed(config: AppConfig, provider: ToolProvider): void {
  if (provider.metadata?.kind !== 'external') {
    return;
  }
  if (provider.metadata.access !== 'read_only') {
    throw new Error(`External tool provider ${provider.id} (kind=${provider.metadata.kind}, access=${provider.metadata.access ?? 'unknown'}) must be read_only`);
  }
  if (!config.tools.externalProvidersEnabled) {
    throw new Error(`External tool provider ${provider.id} (kind=${provider.metadata.kind}, access=${provider.metadata.access ?? 'unknown'}) is disabled by config.tools.externalProvidersEnabled`);
  }
  if (!config.tools.allow.includes(provider.id)) {
    throw new Error(`External tool provider ${provider.id} (kind=${provider.metadata.kind}, access=${provider.metadata.access ?? 'unknown'}) is not allowlisted in config.tools.allow`);
  }
}

export function summarizeRegisteredToolProviders(registry: ToolRegistry): ToolProviderSummary[] {
  return registry.listProviders().map((provider) => ({
    id: provider.id,
    kind: provider.metadata?.kind ?? 'builtin',
    access: provider.metadata?.access ?? 'read_write',
    description: provider.metadata?.description ?? '',
    capabilities: provider.metadata?.capabilities ?? [],
  }));
}

export function registerExtraToolProviders(config: AppConfig, registry: ToolRegistry, providers: ToolProvider[]): ToolRegistry {
  for (const provider of providers) {
    assertExternalToolProviderAllowed(config, provider);
    registry.registerProvider(provider);
  }
  return registry;
}

export function createAgentToolRegistry(
  config: AppConfig,
  policy: PolicyEngine,
  extraProviders: ToolProvider[] = [],
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerProvider(createBuiltinToolProvider(config, policy));
  return registerExtraToolProviders(config, registry, extraProviders);
}

export function createPlannerToolRegistry(
  config: AppConfig,
  policy: PolicyEngine,
  extraProviders: ToolProvider[] = [],
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerProvider(createPlannerToolProvider(config, policy));
  return registerExtraToolProviders(config, registry, extraProviders);
}
