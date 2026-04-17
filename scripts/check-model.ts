import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/load.js';
import { createProviders } from '../src/provider/index.js';
import type { ModelRequest } from '../src/provider/types.js';

async function main(): Promise<void> {
  const parsed = parseArgs({
    options: {
      config: {
        type: 'string',
      },
      model: {
        type: 'string',
      },
    },
  });

  const config = await loadConfig(parsed.values.config);
  const modelAlias = parsed.values.model ?? config.routing.defaultModel;
  const modelProfile = config.models[modelAlias];
  if (!modelProfile) {
    throw new Error(`Unknown model alias: ${modelAlias}`);
  }

  const providers = createProviders(config);
  const provider = providers.get(modelProfile.provider);
  if (!provider) {
    throw new Error(`Provider ${modelProfile.provider} is not available`);
  }

  const request: ModelRequest = {
    providerId: modelProfile.provider,
    model: modelProfile.model,
    systemPrompt: 'You are a connectivity check. Reply with exactly: MODEL_OK',
    messages: [
      {
        role: 'user',
        content: 'Reply with exactly: MODEL_OK',
      },
    ],
    stream: false,
    maxOutputTokens: 32,
    metadata: {
      purpose: 'model-health-check',
    },
  };

  const startedAt = Date.now();
  const response = await provider.invoke(request);
  const elapsedMs = Date.now() - startedAt;
  const content = response.content.trim();

  process.stdout.write(`provider=${provider.id}\n`);
  process.stdout.write(`modelAlias=${modelAlias}\n`);
  process.stdout.write(`model=${modelProfile.model}\n`);
  process.stdout.write(`elapsedMs=${elapsedMs}\n`);
  process.stdout.write(`stopReason=${response.stopReason ?? ''}\n`);
  process.stdout.write(`content=${JSON.stringify(content)}\n`);
  process.stdout.write(`usable=${content.includes('MODEL_OK') ? 'yes' : 'check-response'}\n`);
}

void main();
