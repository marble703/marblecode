import type { AppConfig } from '../config/schema.js';
import type { ModelProvider } from './types.js';
import { OpenAICompatibleProvider } from './openai-compatible.js';

export function createProviders(config: AppConfig): Map<string, ModelProvider> {
  const providers = new Map<string, ModelProvider>();

  for (const [id, providerConfig] of Object.entries(config.providers)) {
    if (providerConfig.type === 'openai-compatible') {
      providers.set(id, new OpenAICompatibleProvider(id, providerConfig));
    }
  }

  return providers;
}
